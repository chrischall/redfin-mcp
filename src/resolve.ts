/**
 * Shared address-resolution strategy used by BOTH
 * `redfin_get_by_address` (single) and `redfin_resolve_addresses`
 * (bulk). The two tools used to diverge — bulk only tried the
 * as-typed query while single also ran suffix-expansion variants,
 * so bulk callers saw `resolved: false` on addresses the single
 * tool would have caught (see issue #71). To prevent that drift
 * from recurring, both tools now call this one helper.
 *
 * Add new fallback rungs here (e.g. gis lookup, region inference)
 * and they automatically apply to both tools. The parity tests in
 * `tests/tools/resolve-addresses.test.ts` will fail if a future
 * change adds a rung to one resolver and not the other.
 *
 * RUNG LADDER (in order):
 *   1. autocomplete (input as-typed)
 *   2. autocomplete (suffix-expansion variant — Rd ↔ Road, etc.)
 *   3. search fallback (#75) — when autocomplete misses entirely:
 *      resolve `{city, state}` to a region, fire a gis search bounded
 *      to that region, and fuzzy-match returned home rows against the
 *      input street's tokens. Only fires when locality info is
 *      provided. Round-3 corpus showed mountain MLS addresses
 *      autocomplete is blind to but gis search has indexed.
 */
import type { RedfinClient } from './client.js';
import {
  parseAddressUrl,
  resolveAddress,
  resolveRegion,
  type RedfinAddress,
  type RedfinRegion,
} from './autocomplete.js';
import { expandAddressVariants } from './suffix.js';
import {
  assertRegionMatches,
  buildGisPath,
  type RawHome,
} from './tools/search.js';

export interface AddressParts {
  /** Required free-text street ("158 Raven Blvd" or "158 Raven Blvd Lake Lure NC 28746"). */
  street: string;
  city?: string;
  state?: string;
  zip?: string;
}

/** Which rung surfaced the match. */
export type MatchedVia = 'autocomplete' | 'search_fallback';

export interface ResolveResult {
  /** The resolved address, or null if every rung missed. */
  match: RedfinAddress | null;
  /** Every query string tried, in attempt order. Useful for debugging misses. */
  attempts: string[];
  /** The variant string that actually matched. Undefined when nothing matched. */
  matchedVariant?: string;
  /** Which rung returned the match. Undefined when nothing matched. */
  matchedVia?: MatchedVia;
}

/**
 * Build the candidate variants for an address-parts input.
 *
 * Rung 1 — input as-typed (street + optional city/state/zip joined).
 * Rung 2 — suffix-expansion variant on the STREET PORTION ONLY
 *           (e.g. `Rd` ↔ `Road`). See issue #43.
 *
 * The street is expanded first, then the city/state/zip suffix is
 * appended to each variant. Duplicates are skipped (e.g. `Way` has no
 * alternate, so it's a one-rung walk).
 */
export function buildVariants(input: AddressParts): string[] {
  const cityStateZip = [input.city, input.state, input.zip]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(' ');
  const streetVariants = expandAddressVariants(input.street);
  // De-dupe across full-query forms in case city/state/zip empty +
  // a swap produces no change.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of streetVariants) {
    const candidate = cityStateZip ? `${s} ${cityStateZip}` : s;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

/** Tokenize a street label into lowercase alpha words. Strips the
 * leading street number and any punctuation. Suffix-aware via
 * `expandAddressVariants` — both forms of the street's suffix word
 * (Rd / Road) feed into the token set so matching is bidirectional. */
function streetTokens(street: string | undefined): Set<string> {
  if (!street) return new Set();
  const variants = expandAddressVariants(street);
  const out = new Set<string>();
  for (const v of variants) {
    const words = v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const w of words) out.add(w);
  }
  return out;
}

/** Generic street-suffix tokens shared by thousands of unrelated
 * streets — without filtering these out, "1 Different Rd" would
 * fuzzy-match "212 Ridgeway Rd" on the shared "rd" token alone.
 * Mirrors the abbreviated + full forms in `suffix.ts`. */
const SUFFIX_NOISE = new Set([
  'rd', 'road',
  'ln', 'lane',
  'dr', 'drive',
  'ct', 'court',
  'blvd', 'boulevard',
  'cir', 'circle',
  'hwy', 'highway',
  'pkwy', 'parkway',
  'ave', 'avenue',
  'st', 'street',
  'pl', 'place',
  'trl', 'trail',
  'ter', 'terrace',
  'way',
  'sq', 'square',
  'xing', 'crossing',
  'aly', 'alley',
  'pt', 'point',
  'mtn', 'mountain',
  'vw', 'view',
  'vly', 'valley',
  // Compass directions show up as part of countless street names
  // — keeping them in the name-token set would over-match.
  'n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw',
  'north', 'east', 'south', 'west',
]);

/** Discriminating non-numeric tokens — the street-name body without
 * the house number AND without the generic suffix noise. Used to
 * compare two street strings for equality without false-positive
 * matches on shared numbers or shared "rd" tokens. */
function nameTokens(street: string | undefined): Set<string> {
  const all = streetTokens(street);
  const out = new Set<string>();
  for (const t of all) {
    if (/^\d+$/.test(t)) continue;
    if (SUFFIX_NOISE.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Get the leading house-number token, if any. Returns null when the
 * street doesn't start with a number. */
function houseNumber(street: string | undefined): string | null {
  if (!street) return null;
  const m = /^\s*(\d+)\b/.exec(street);
  return m ? m[1] : null;
}

/** Score how well a gis-returned home street matches the input
 * street. Higher is better; 0 means no match at all.
 *   - House number matches: +10 (load-bearing — without this we
 *     could pick the wrong home on the same street).
 *   - Each shared non-numeric name token: +1.
 * Returns 0 when there are no shared name tokens — pure
 * number-only matches don't count. */
function scoreStreetMatch(input: string, candidate: string): number {
  const inputNames = nameTokens(input);
  const candNames = nameTokens(candidate);
  let nameOverlap = 0;
  for (const t of inputNames) if (candNames.has(t)) nameOverlap++;
  if (nameOverlap === 0) return 0;
  const inputNum = houseNumber(input);
  const candNum = houseNumber(candidate);
  const numberBonus = inputNum && candNum && inputNum === candNum ? 10 : 0;
  return numberBonus + nameOverlap;
}

/** Coerce a `RawHome.streetLine` (either a string or a `{value}`
 * envelope) into a string. */
function streetLineOf(home: RawHome): string {
  const sl = home.streetLine;
  if (!sl) return '';
  if (typeof sl === 'string') return sl;
  return sl.value ?? '';
}

/** Build the "city state" or "zip" query we hand to autocomplete to
 * resolve a Places region for the search-fallback rung. Returns null
 * when there's nothing to bound the search by. */
function regionQueryFromInput(input: AddressParts): string | null {
  const cityState = [input.city, input.state]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(' ');
  if (cityState) return cityState;
  if (input.zip && input.zip.trim()) return input.zip.trim();
  return null;
}

/** Convert a matched gis home row into the canonical `RedfinAddress`
 * shape the autocomplete rung returns. Falls back gracefully when
 * the URL doesn't fit the canonical pattern (rare; just synthesizes
 * what we can from the raw fields). */
function homeToAddress(home: RawHome): RedfinAddress | null {
  const url = home.url;
  if (!url) return null;
  const parsed = parseAddressUrl(url);
  const streetLine = streetLineOf(home);
  const fullUrl = url.startsWith('http') ? url : `https://www.redfin.com${url}`;
  if (parsed) {
    return {
      home_id: parsed.home_id,
      url: fullUrl,
      path: url,
      street_address: streetLine || parsed.street,
      city: home.city ?? parsed.city,
      state: home.state ?? parsed.state,
      zip: home.zip ?? parsed.zip,
    };
  }
  // URL didn't fit the canonical home shape — try to extract the
  // home_id from a `/home/<id>` tail and synthesize the rest.
  const idMatch = /\/home\/(\d+)\/?$/.exec(url);
  if (!idMatch) return null;
  return {
    home_id: idMatch[1],
    url: fullUrl,
    path: url,
    street_address: streetLine,
    city: home.city ?? '',
    state: home.state ?? '',
    zip: home.zip ?? '',
  };
}

/**
 * Search-fallback rung (#75). Resolve `{city, state}` (or `{zip}`)
 * to a Places region, run a gis search bounded to that region, and
 * pick the best-matching home by street-token + house-number score.
 *
 * Returns null when:
 *   - no locality info is available to bound the search,
 *   - region resolution misses,
 *   - gis returns zero homes,
 *   - no home's street tokens overlap with the input.
 *
 * Throws when `assertRegionMatches` detects Redfin's silent fallback
 * (e.g. ZIP 28746 returning Seattle homes) — those errors are
 * load-bearing and must surface to the caller, not be swallowed.
 */
async function searchFallbackResolve(
  client: RedfinClient,
  input: AddressParts
): Promise<RedfinAddress | null> {
  const regionQuery = regionQueryFromInput(input);
  if (!regionQuery) return null;
  const region: RedfinRegion | null = await resolveRegion(client, regionQuery);
  if (!region) return null;
  const path = buildGisPath(region, { location: regionQuery, limit: 350 });
  const env = await client.fetchStingrayJson<{
    homes?: RawHome[];
    serviceRegionName?: string;
  }>(path);
  const raw = env.payload?.homes ?? [];
  // Reuse the existing silent-fallback guard — same one
  // `redfin_search_properties` runs. Surfaces ZIP→wrong-state,
  // unrelated serviceRegionName, and unrelated-homes cases. Pass the
  // ZIP when available so the ZIP→state path fires even though the
  // region we resolved went through a city/state query.
  const guardInput = input.zip ?? regionQuery;
  assertRegionMatches(
    region,
    {
      serviceRegionName: env.payload?.serviceRegionName,
      homes: raw.map((h) => ({ city: h.city, state: h.state })),
    },
    guardInput
  );
  if (raw.length === 0) return null;
  let best: { home: RawHome; score: number } | null = null;
  for (const home of raw) {
    const candStreet = streetLineOf(home);
    const score = scoreStreetMatch(input.street, candStreet);
    if (score === 0) continue;
    if (!best || score > best.score) best = { home, score };
  }
  if (!best) return null;
  return homeToAddress(best.home);
}

/**
 * Walk the rungs in order:
 *   1+2. autocomplete variants (input + suffix-expansion).
 *   3. search-fallback rung (#75) — gis search bounded by locality.
 *
 * Stop on the first hit. `resolveAddress` returns null for "no match"
 * (drives fallthrough) and throws for real errors (auth/WAF/network)
 * — those propagate to the caller. Same propagation contract for the
 * search-fallback rung's `assertRegionMatches` errors.
 */
export async function resolveAddressWithFallbacks(
  client: RedfinClient,
  input: AddressParts
): Promise<ResolveResult> {
  const candidates = buildVariants(input);
  const attempts: string[] = [];
  for (const variant of candidates) {
    attempts.push(variant);
    const match = await resolveAddress(client, variant);
    if (match) {
      return { match, attempts, matchedVariant: variant, matchedVia: 'autocomplete' };
    }
  }
  // Every autocomplete variant missed — try the search-fallback rung.
  // The marker entry in `attempts` lets callers see we tried it even
  // when it ultimately returned null.
  const regionQuery = regionQueryFromInput(input);
  if (regionQuery) {
    attempts.push(`search:${regionQuery}`);
    const fallbackMatch = await searchFallbackResolve(client, input);
    if (fallbackMatch) {
      return { match: fallbackMatch, attempts, matchedVia: 'search_fallback' };
    }
  }
  return { match: null, attempts };
}
