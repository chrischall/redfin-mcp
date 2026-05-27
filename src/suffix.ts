/**
 * Street-suffix abbreviation expansion for address resolution
 * retries. Redfin's autocomplete is strict about the upstream
 * canonical form — `268 Mallard Rd` doesn't resolve in 28746 even
 * though Redfin clearly has the listing as `268 Mallard Road`.
 * (See issue #43, real-session regression.)
 *
 * `expandAddressVariants(address)` returns the input PLUS expansion
 * candidates we should try after the exact match fails. Each variant
 * swaps a single suffix token (last word, possibly trailing
 * punctuation) between its abbreviated and full form.
 */

/**
 * Bidirectional pairs — abbreviated form ↔ long form. Adapted from
 * USPS Pub 28 Appendix C2 and pruned to the high-traffic ones.
 */
const SUFFIX_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['Rd', 'Road'],
  ['Ln', 'Lane'],
  ['Dr', 'Drive'],
  ['Ct', 'Court'],
  ['Blvd', 'Boulevard'],
  ['Cir', 'Circle'],
  ['Hwy', 'Highway'],
  ['Pkwy', 'Parkway'],
  ['Ave', 'Avenue'],
  ['St', 'Street'],
  ['Pl', 'Place'],
  ['Trl', 'Trail'],
  ['Ter', 'Terrace'],
  ['Way', 'Way'], // identity — Way has no alternate form; left so the lookup table is exhaustive
  ['Sq', 'Square'],
  ['Xing', 'Crossing'],
  ['Aly', 'Alley'],
  ['Pt', 'Point'],
  ['Mtn', 'Mountain'],
  ['Vw', 'View'],
  ['Vly', 'Valley'],
];

// Build both lookup directions once.
const ABBR_TO_FULL = new Map<string, string>();
const FULL_TO_ABBR = new Map<string, string>();
for (const [abbr, full] of SUFFIX_PAIRS) {
  if (abbr === full) continue;
  ABBR_TO_FULL.set(abbr.toLowerCase(), full);
  FULL_TO_ABBR.set(full.toLowerCase(), abbr);
}

/**
 * Match the last word of the street portion (before any city/state/
 * zip in the same string) and consider it as the suffix candidate.
 *
 * For "268 Mallard Rd, Lake Lure NC 28746" we want to swap "Rd" → "Road",
 * not "Lure" or "28746". The split is conservative — anything past
 * the first comma is left alone.
 */
function splitStreetFromRemainder(address: string): {
  street: string;
  remainder: string;
} {
  const commaIdx = address.indexOf(',');
  if (commaIdx < 0) return { street: address, remainder: '' };
  return {
    street: address.slice(0, commaIdx),
    remainder: address.slice(commaIdx),
  };
}

/**
 * Strip and return any trailing punctuation from a token. Used so
 * a tail like "Rd." matches the abbrev table without losing the dot.
 */
function partsForToken(token: string): { core: string; trailingPunct: string } {
  const m = /^(.+?)([.,;:]*)$/.exec(token);
  if (!m) return { core: token, trailingPunct: '' };
  return { core: m[1], trailingPunct: m[2] };
}

/**
 * Produce the swap variant for a single street portion. Returns null
 * when the last token isn't a known suffix.
 */
function swapSuffixVariant(street: string): string | null {
  const trimmed = street.trimEnd();
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace < 0) return null;
  const head = trimmed.slice(0, lastSpace);
  const lastToken = trimmed.slice(lastSpace + 1);
  const { core, trailingPunct } = partsForToken(lastToken);
  const lower = core.toLowerCase();
  const swap = ABBR_TO_FULL.get(lower) ?? FULL_TO_ABBR.get(lower);
  if (!swap) return null;
  // Preserve simple casing: if the original token was capitalized
  // (Rd / Road), the swap is too. Otherwise pass through.
  const cased =
    core[0] === core[0].toUpperCase() ? swap : swap.toLowerCase();
  return `${head} ${cased}${trailingPunct}`;
}

/**
 * Return the original address followed by suffix-swap variants. The
 * caller tries each in order, stopping on the first that resolves.
 * Deduped — no value appears twice.
 */
export function expandAddressVariants(address: string): string[] {
  if (!address) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: string) => {
    const key = s.trim();
    if (!key) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  push(address);

  const { street, remainder } = splitStreetFromRemainder(address);
  const swapped = swapSuffixVariant(street);
  if (swapped) push(`${swapped}${remainder}`);

  return out;
}

/**
 * Convenience: the FIRST address variant to try is the input itself;
 * the rest are alternates. Exposed for callers that want to log which
 * variant resolved.
 */
export function listVariants(address: string): {
  primary: string;
  alternates: string[];
} {
  const all = expandAddressVariants(address);
  return { primary: all[0] ?? address, alternates: all.slice(1) };
}
