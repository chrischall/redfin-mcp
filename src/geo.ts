/**
 * Light geographic sanity-checks for ZIP-keyed search queries.
 *
 * Today's check: ZIP → expected state(s). This catches the canonical
 * #46 regression (ZIP 28746 returning Seattle Fremont results — a
 * North-Carolina ZIP serving Washington-state homes). The static
 * table below maps each ZIP prefix to the small set of states whose
 * ZIPs share that prefix; we use the FIRST DIGIT (loose) or the FIRST
 * THREE DIGITS (tight) depending on confidence.
 *
 * The data is from public USPS ZIP-prefix references; we keep only the
 * coarse first-digit mapping here because it's enough to catch
 * cross-continent fallbacks (the canonical bug class) and stays
 * accurate enough to avoid false positives on legitimate fringe ZIPs.
 */

/**
 * First-digit → set of states whose 5-digit ZIPs may begin with that
 * digit. Comprehensive enough for cross-continent sanity checks.
 */
const FIRST_DIGIT_TO_STATES: Record<string, ReadonlySet<string>> = {
  '0': new Set(['CT', 'MA', 'ME', 'NH', 'NJ', 'PR', 'RI', 'VT', 'VI', 'AE']),
  '1': new Set(['DE', 'NY', 'PA']),
  '2': new Set(['DC', 'MD', 'NC', 'SC', 'VA', 'WV']),
  '3': new Set(['AL', 'FL', 'GA', 'MS', 'TN', 'AA']),
  '4': new Set(['IN', 'KY', 'MI', 'OH']),
  '5': new Set(['IA', 'MN', 'MT', 'ND', 'SD', 'WI']),
  '6': new Set(['IL', 'KS', 'MO', 'NE']),
  '7': new Set(['AR', 'LA', 'OK', 'TX']),
  '8': new Set(['AZ', 'CO', 'ID', 'NM', 'NV', 'UT', 'WY']),
  '9': new Set(['AK', 'AS', 'CA', 'GU', 'HI', 'MP', 'OR', 'WA', 'AP']),
};

/**
 * Return the set of state codes a 5-digit US ZIP could plausibly
 * belong to, based on its first digit. Returns null when the input
 * isn't a 5-digit US ZIP we can pattern-match (Canadian postal codes,
 * 9-digit ZIPs with hyphens, etc.).
 */
export function zipPlausibleStates(zip: string | undefined | null): Set<string> | null {
  if (!zip) return null;
  const trimmed = zip.trim();
  // Tolerate "12345-6789" by considering the leading 5 digits.
  const m = /^(\d{5})(?:-\d{4})?$/.exec(trimmed);
  if (!m) return null;
  const states = FIRST_DIGIT_TO_STATES[m[1][0]];
  return states ? new Set(states) : null;
}

/**
 * Quick check: do the returned homes' states match the ZIP-derived
 * expected states? Returns `null` when we can't make a determination
 * (non-US ZIP, no homes, empty states). Returns `false` only when we
 * are CONFIDENT the result doesn't match.
 */
export function homesMatchZipState(
  zip: string | undefined | null,
  homeStates: Array<string | undefined | null>
): { plausibleStates: Set<string> | null; matched: boolean | null } {
  const plausible = zipPlausibleStates(zip);
  if (!plausible) return { plausibleStates: null, matched: null };
  const seen = new Set<string>();
  for (const s of homeStates) {
    if (s) seen.add(s.toUpperCase());
  }
  if (seen.size === 0) return { plausibleStates: plausible, matched: null };
  for (const got of seen) if (plausible.has(got)) {
    return { plausibleStates: plausible, matched: true };
  }
  return { plausibleStates: plausible, matched: false };
}

/**
 * Detect whether a free-text location string starts with a US ZIP.
 * Used to gate the ZIP-state check — we only run it when the caller
 * actually typed a ZIP.
 */
export function extractZipFromLocation(location: string | undefined): string | null {
  if (!location) return null;
  const m = /\b(\d{5})(?:-\d{4})?\b/.exec(location);
  return m ? m[1] : null;
}
