import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { resolveBoth, type RedfinAddress } from '../autocomplete.js';
import { buildPortalUrlHyperlink, priceDrop } from '../derived.js';
import { extractZipFromLocation, homesMatchZipState } from '../geo.js';

/**
 * Redfin's search API: `GET /stingray/api/gis?...&region_id=X&region_type=Y`
 *
 * Steps:
 *   1. Resolve the user's free-text location to a region (region_id +
 *      region_type) via `location-autocomplete`.
 *   2. Call the gis endpoint with the region + filter params. Filters
 *      ride as query-string ints/CSVs (Redfin's web app does the same).
 *   3. Strip the `{}&&` prefix (RedfinClient.fetchStingrayJson handles
 *      this), then format `payload.homes[]` into a stable shape.
 *
 * Status codes (the `status` query param):
 *   1 = active for sale (the default)
 *   9 = active + coming-soon + contingent + pending (Redfin's default
 *       "everything for sale" view; gives more results than 1 alone)
 *
 * Verified live 2026-05-23 against region 30749 (New York City).
 */

type HomeType =
  | 'house'
  | 'condo'
  | 'townhouse'
  | 'multi_family'
  | 'manufactured'
  | 'land';

/** Redfin's `uipt` (UI Property Type) bitmap values. */
const HOME_TYPE_UIPT: Record<HomeType, number> = {
  house: 1,
  condo: 2,
  townhouse: 3,
  multi_family: 4,
  land: 5,
  manufactured: 6,
};

type StatusKey = 'for_sale' | 'for_rent' | 'sold';

const STATUS_CODES: Record<StatusKey, number> = {
  for_sale: 9,
  for_rent: 9, // Different URL path entirely on Redfin (`/apartments-for-rent/...`); v0.1.0 returns sale results.
  sold: 9, // Same — sold has a separate `/recently-sold` path. v0.1.0 supports for_sale only.
};

export interface RawHome {
  propertyId?: number;
  listingId?: number;
  mlsId?: { value?: string };
  mlsStatus?: string;
  url?: string;
  streetLine?: { value?: string } | string;
  unitNumber?: { value?: string };
  city?: string;
  state?: string;
  zip?: string;
  price?: number | { value?: number };
  /** Redfin's gis API surfaces the prior list price as `previousPrice`
   * (or `originalPrice` on some payload variants). Either is good for
   * the price-drop derived fields (#35). */
  previousPrice?: number | { value?: number };
  originalPrice?: number | { value?: number };
  beds?: number;
  baths?: number;
  sqFt?: number | { value?: number };
  pricePerSqFt?: number | { value?: number };
  lotSize?: number | { value?: number };
  yearBuilt?: number | { value?: number };
  hoa?: number | { value?: number };
  latLong?: { value?: { latitude?: number; longitude?: number } };
  propertyType?: number;
  uiPropertyType?: number;
  searchStatus?: number;
  timeOnRedfin?: number;
  dom?: { value?: number };
}

export interface FormattedHome {
  property_id: number;
  listing_id?: number;
  mls_id?: string;
  status?: string;
  url: string;
  /** Sheets-paste-ready `=HYPERLINK(url,"Redfin")`. Always present. (#41) */
  portal_url_hyperlink: string;
  address: string;
  street?: string;
  unit?: string;
  city?: string;
  state?: string;
  zip?: string;
  price?: number;
  previous_list_price?: number;
  /** `previous_list_price - price`. `null` when either is missing. (#35) */
  price_drop_amount?: number | null;
  /** `(previous - current) / previous * 100`, rounded to 0.1. (#35) */
  price_drop_percent?: number | null;
  price_per_sqft?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  lot_size?: number;
  year_built?: number;
  hoa_monthly?: number;
  latitude?: number;
  longitude?: number;
  property_type?: number;
  days_on_redfin?: number;
}

/** Unwrap `{value: X}` envelope, or pass through raw values. */
function v<T>(x: T | { value?: T } | undefined): T | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'object' && 'value' in (x as object)) {
    return (x as { value?: T }).value;
  }
  return x as T;
}

export function formatHome(raw: RawHome): FormattedHome | null {
  if (!raw.propertyId) return null;
  const street = v(raw.streetLine);
  const unit = v(raw.unitNumber);
  const fullUrl = raw.url
    ? raw.url.startsWith('http')
      ? raw.url
      : `https://www.redfin.com${raw.url}`
    : `https://www.redfin.com/home/${raw.propertyId}`;
  const address = [
    [street, unit].filter(Boolean).join(' ').trim(),
    raw.city,
    raw.state,
    raw.zip,
  ]
    .filter(Boolean)
    .join(', ');
  const currentPrice = v(raw.price);
  const previousListPrice = v(raw.previousPrice) ?? v(raw.originalPrice);
  const drop = priceDrop(currentPrice, previousListPrice);
  return {
    property_id: raw.propertyId,
    listing_id: raw.listingId,
    mls_id: v(raw.mlsId as { value?: string }),
    status: raw.mlsStatus,
    url: fullUrl,
    portal_url_hyperlink: buildPortalUrlHyperlink(fullUrl),
    address,
    street,
    unit,
    city: raw.city,
    state: raw.state,
    zip: raw.zip,
    price: currentPrice,
    ...(typeof previousListPrice === 'number'
      ? { previous_list_price: previousListPrice }
      : {}),
    price_drop_amount: drop.price_drop_amount,
    price_drop_percent: drop.price_drop_percent,
    price_per_sqft: v(raw.pricePerSqFt),
    beds: raw.beds,
    baths: raw.baths,
    sqft: v(raw.sqFt),
    lot_size: v(raw.lotSize),
    year_built: v(raw.yearBuilt),
    hoa_monthly: v(raw.hoa),
    latitude: raw.latLong?.value?.latitude,
    longitude: raw.latLong?.value?.longitude,
    property_type: raw.uiPropertyType ?? raw.propertyType,
    days_on_redfin: v(raw.dom),
  };
}

export interface SearchInput {
  location: string;
  status?: StatusKey;
  price_min?: number;
  price_max?: number;
  beds_min?: number;
  baths_min?: number;
  home_types?: HomeType[];
  limit?: number;
}

/**
 * Tokenize a label into lowercase alpha words for fuzzy matching.
 * "North Brooklyn" → ["north", "brooklyn"]. "arbor-heights" → ["arbor", "heights"].
 */
function tokens(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Two-letter US state codes we strip from the noise-token set; they
// appear inside thousands of unrelated addresses and would turn any
// silent fallback into a false-positive match.
const NOISE_TOKENS = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id',
  'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms',
  'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok',
  'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv',
  'wi', 'wy', 'dc', 'pr', 'usa', 'us',
]);

function discriminatingTokens(s: string | undefined): Set<string> {
  const out = new Set(tokens(s));
  for (const n of NOISE_TOKENS) out.delete(n);
  return out;
}

/**
 * Throw if the gis call's response doesn't actually describe the
 * requested region. Three failure modes surface here:
 *
 *   1. `serviceRegionName` is set but unrelated (e.g. you asked for
 *      "Brooklyn" type-6, gis returned "arbor-heights"). This is the
 *      original silent-fallback bug from v0.4.1.
 *   2. `serviceRegionName` is absent but the returned `homes[]` are
 *      in a different city/state than the resolved region (e.g.
 *      Asheville, NC type-2 returns gis homes in Ipswich, MA). Newer
 *      gis behavior — same underlying fallback, just no diagnostic
 *      field. Verified live 2026-05-24 against Asheville (2_555).
 *   3. The location was a ZIP and the returned homes' states are
 *      inconsistent with the ZIP's first-digit prefix (e.g. ZIP 28746
 *      → North Carolina; got Washington homes). Catches the canonical
 *      cross-continent fallback (#46). The ZIP check fires BEFORE
 *      path 2 because state-level mismatches are the most dangerous
 *      class — silently mixing in other-state listings corrupts
 *      downstream analysis.
 *
 * Zero results are accepted as legitimate (small markets with no
 * Redfin MLS coverage will get an empty result with a notice from the
 * caller).
 */
export function assertRegionMatches(
  region: { name: string; sub_name?: string; region_type: number; region_id: number },
  payload: {
    serviceRegionName?: string;
    homes?: Array<{ city?: string; state?: string }>;
  },
  inputLocation?: string
): void {
  // Path 3 (run FIRST): ZIP → expected states sanity check. Fires only
  // when the caller's location string contains a recognizable US ZIP
  // and the result set has any homes to check. Stops cross-continent
  // fallbacks (canonical case: ZIP 28746 returning Seattle results) (#46).
  const zip = extractZipFromLocation(inputLocation);
  if (zip) {
    const homes = payload.homes ?? [];
    const zipCheck = homesMatchZipState(
      zip,
      homes.map((h) => h.state)
    );
    if (zipCheck.matched === false && zipCheck.plausibleStates) {
      const plausible = Array.from(zipCheck.plausibleStates).sort().join(', ');
      const firstState = homes[0]?.state ?? '?';
      const firstCity = homes[0]?.city ?? 'an unknown city';
      throw new Error(
        `redfin_search_properties: ZIP ${zip} not in Redfin's coverage — ` +
          `the gis API returned ${homes.length} result(s) in ${firstCity}, ${firstState}, ` +
          `but ZIP ${zip} belongs to ${plausible}. ` +
          `This is Redfin's cross-continent silent fallback — try the city name instead ` +
          `(e.g. "Lake Lure, NC" rather than "${zip}"), or use \`redfin_get_by_address\` ` +
          `for per-property lookup.`
      );
    }
  }

  const wanted = new Set([
    ...discriminatingTokens(region.name),
    ...discriminatingTokens(region.sub_name),
  ]);
  if (wanted.size === 0) return; // nothing discriminating to check

  // Path 1: serviceRegionName provided — slug-style match against wanted.
  if (payload.serviceRegionName) {
    const got = discriminatingTokens(payload.serviceRegionName);
    for (const w of wanted) if (got.has(w)) return;
    throw new Error(
      `redfin_search_properties: Redfin's gis API doesn't fully support this region — ` +
        `requested "${region.name}" (${region.region_type}_${region.region_id}) but the server ` +
        `returned results for "${payload.serviceRegionName}". This commonly happens with neighborhood-typed ` +
        `regions in big cities. Try a parent city (e.g. "New York" instead of "Brooklyn"), or pass ` +
        `region_id + region_type directly for a known-working pair.`
    );
  }

  // Path 2: serviceRegionName absent — check the actual homes' cities.
  const homes = payload.homes ?? [];
  if (homes.length === 0) return; // 0 results is a legit signal; caller surfaces it.
  for (const h of homes) {
    const got = new Set([
      ...discriminatingTokens(h.city),
      ...discriminatingTokens(h.state),
    ]);
    for (const w of wanted) if (got.has(w)) return;
  }
  const firstCity = homes[0]?.city ?? 'an unknown city';
  const firstState = homes[0]?.state ?? '?';
  throw new Error(
    `redfin_search_properties: Redfin's gis API silently fell back — ` +
      `requested "${region.name}" (${region.region_type}_${region.region_id}) but all ${homes.length} ` +
      `returned result(s) are in ${firstCity}, ${firstState} (or similar) — none match the requested region. ` +
      `This happens with smaller markets outside Redfin's MLS coverage. Try a nearby larger city or county, ` +
      `or pass region_id + region_type directly for a known-working pair.`
  );
}

/**
 * Build the gis endpoint path + params for a resolved region + filters.
 */
export function buildGisPath(
  region: { region_id: number; region_type: number },
  input: SearchInput
): string {
  const limit = input.limit ?? 40;
  const uipt =
    input.home_types && input.home_types.length > 0
      ? input.home_types.map((t) => HOME_TYPE_UIPT[t]).join(',')
      : '1,2,3,4,5,6,7,8';
  const params: Record<string, string> = {
    al: '1',
    num_homes: String(limit),
    region_id: String(region.region_id),
    region_type: String(region.region_type),
    sf: '1,2,3,5,6,7',
    start: '0',
    status: String(STATUS_CODES[input.status ?? 'for_sale']),
    uipt,
    v: '8',
  };
  if (input.price_min !== undefined) params.min_price = String(input.price_min);
  if (input.price_max !== undefined) params.max_price = String(input.price_max);
  if (input.beds_min !== undefined) params.num_beds = String(input.beds_min);
  if (input.baths_min !== undefined) params.num_baths = String(input.baths_min);
  return `/stingray/api/gis?${new URLSearchParams(params).toString()}`;
}

/**
 * When autocomplete returns NO Places match but DID match an
 * Addresses row, the user clearly meant "find this specific home" —
 * not "search the region around it". Surface the resolved address as
 * a one-row result so the caller can pick up the home_id and follow
 * up with `redfin_get_property` if they want details. Skips the gis
 * call entirely.
 *
 * The shape mirrors a normal `redfin_search_properties` response so a
 * caller iterating `results[]` doesn't need a special-case branch;
 * `resolved_as: 'address'` is the discriminator if they do.
 */
export function addressOnlyResult(address: RedfinAddress): {
  region: null;
  resolved_as: 'address';
  notice: string;
  results: FormattedHome[];
} {
  const fullUrl = address.url;
  const result: FormattedHome = {
    property_id: parseInt(address.home_id, 10),
    url: fullUrl,
    portal_url_hyperlink: buildPortalUrlHyperlink(fullUrl),
    address: [address.street_address, address.city, address.state, address.zip]
      .filter(Boolean)
      .join(', '),
    street: address.street_address,
    city: address.city,
    state: address.state,
    zip: address.zip,
    price_drop_amount: null,
    price_drop_percent: null,
  };
  return {
    region: null,
    resolved_as: 'address',
    notice:
      "Redfin's autocomplete matched the input as a single address (not a region), so we skipped the gis search and returned the resolved home. " +
      'Call `redfin_get_property` with this URL for the full property record.',
    results: [result],
  };
}

export function registerSearchTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_search_properties',
    {
      title: 'Search Redfin listings',
      description:
        "Search Redfin listings by location (city, ZIP, neighborhood, or full street address) and optional filters. Resolves the location via Redfin's autocomplete then queries the gis API; full street addresses short-circuit to the single matched home (no gis call). Returns matching properties with price, beds/baths, sqft, year built, address, and the Redfin home URL. `resolved_as` is `'region'` / `'address'`. `coverage` is `'full'` (gis indexed this region), `'profile_only'` (Redfin has profiles for individual addresses here but search isn't indexed — use redfin_get_by_address per property), or `'none'`. `result_cap_hit: true` signals the gis API returned its ~350 hard cap and more listings exist — narrow with price/beds filters. ZIP queries that fall into Redfin's cross-continent fallback (e.g. ZIP 28746 returning Seattle results) now error loudly. v0.1.0 supports `for_sale` status only. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Search Redfin listings',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        location: z
          .string()
          .describe(
            'Free-text location: city, ZIP, neighborhood, or address (e.g. "Brooklyn, NY", "94110", "Park Slope")'
          ),
        status: z
          .enum(['for_sale', 'for_rent', 'sold'])
          .optional()
          .describe('Listing status. Only for_sale fully works in v0.1.0.'),
        price_min: z.number().int().nonnegative().optional(),
        price_max: z.number().int().nonnegative().optional(),
        beds_min: z.number().int().nonnegative().optional(),
        baths_min: z.number().int().nonnegative().optional(),
        home_types: z
          .array(
            z.enum([
              'house',
              'condo',
              'townhouse',
              'multi_family',
              'manufactured',
              'land',
            ])
          )
          .optional()
          .describe('Restrict to one or more property types.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max listings to return (default 40).'),
      },
    },
    async (input) => {
      // One autocomplete call returns both a Places (region) and an
      // Addresses match when either exists. Address-typed queries
      // (full street addresses) typically return Addresses-only —
      // before this change we'd error out, even though the user gave
      // us a perfectly resolvable address. Fix for #24.
      const { region, address } = await resolveBoth(client, input.location);
      if (!region) {
        if (address) {
          // coverage: "profile_only" — Redfin has the address-level
          // profile page but no gis/MLS coverage for the surrounding
          // region. Surfaced explicitly so callers know to keep using
          // per-address resolution rather than retrying with a broader
          // search. (#47)
          return textResult({
            ...addressOnlyResult(address),
            coverage: 'profile_only' as const,
          });
        }
        throw new Error(
          `redfin_search_properties: could not resolve location "${input.location}" to a Redfin region or address. ` +
            `If you have a full street address, try \`redfin_get_by_address\` instead.`
        );
      }
      const path = buildGisPath(region, input);
      const env = await client.fetchStingrayJson<{
        homes?: RawHome[];
        serviceRegionName?: string;
      }>(path);
      const raw = env.payload?.homes ?? [];
      // Detect Redfin's silent-fallback failure modes: gis ignores the
      // region and returns either (a) results for a different
      // serviceRegionName, (b) results whose city/state share no
      // discriminating tokens with the requested region, or (c) ZIP →
      // wrong-state results (the cross-continent fallback). #46.
      assertRegionMatches(
        region,
        {
          serviceRegionName: env.payload?.serviceRegionName,
          homes: raw.map((h) => ({ city: h.city, state: h.state })),
        },
        input.location
      );
      const limit = input.limit ?? 40;
      const formatted = raw
        .map(formatHome)
        .filter((h): h is FormattedHome => h !== null)
        .slice(0, limit);

      // #45 silent-cap audit. Redfin's gis API returns at most
      // ~350 homes per call (verified live across high-density metros;
      // Redfin's web UI paginates beyond that). We don't paginate
      // server-side today — instead surface a `result_cap_hit` flag
      // and a hint so callers know when to narrow their query.
      const REDFIN_GIS_HARD_CAP = 350;
      const resultCapHit =
        raw.length >= REDFIN_GIS_HARD_CAP &&
        formatted.length === raw.length; // i.e. limit didn't bite first

      // #47 coverage. Map (gis returned homes) → 'full'; (gis empty
      // but Redfin clearly has individual profiles) → 'profile_only'
      // when an address match also resolved on the same query;
      // otherwise 'none'.
      // We can detect address-availability cheaply by checking whether
      // resolveBoth also returned an `address` value. Today's
      // implementation runs that lookup once at the top of this
      // handler.
      const coverage: 'full' | 'profile_only' | 'none' =
        formatted.length > 0
          ? 'full'
          : address
            ? 'profile_only'
            : 'none';

      // Surface a helpful notice when gis legitimately has no listings
      // for a resolved-but-tiny market (e.g. Lake Lure, NC).
      const notice =
        formatted.length === 0
          ? `Redfin's gis API returned 0 results for region ${region.region_type}_${region.region_id} ("${region.name}"). ` +
            `coverage: ${coverage}. ` +
            (coverage === 'profile_only'
              ? "Redfin has per-property profile pages here but does not index this market in search — use `redfin_get_by_address` for individual properties."
              : "This often means the location is outside Redfin's MLS coverage rather than that there are genuinely no listings. Try a nearby larger city, the county, or compare against redfin.com directly.")
          : resultCapHit
            ? `Redfin's gis API returned the hard cap (~${REDFIN_GIS_HARD_CAP}) of results — more listings likely exist for this region. Narrow with price/beds filters, or query a smaller sub-region, to enumerate the long tail.`
            : undefined;
      return textResult({
        resolved_as: 'region' as const,
        region: {
          name: region.name,
          sub_name: region.sub_name,
          region_id: region.region_id,
          region_type: region.region_type,
        },
        coverage,
        result_cap_hit: resultCapHit,
        ...(notice ? { notice } : {}),
        results: formatted,
      });
    }
  );
}
