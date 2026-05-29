/**
 * Light geographic sanity-checks for ZIP-keyed search queries.
 *
 * The core checks — ZIP → plausible state(s) (`zipPlausibleStates`),
 * the first-digit→states table (`FIRST_DIGIT_TO_STATES`), and free-text
 * ZIP extraction (`extractZipFromLocation`) — now live in
 * `@chrischall/realty-core` (cohort migration realty-mcp#1); they were
 * surveyed from this very file and are byte-identical, so we re-export
 * them rather than keep a local copy.
 *
 * `homesMatchZipState` stays here: redfin's `redfin_search_properties`
 * silent-fallback guard needs the matched plausible-state SET to build
 * its error message ("ZIP 28746 belongs to NC, SC, …"), so we keep the
 * richer `{ plausibleStates, matched }` return shape rather than adopt
 * realty-core's bare-boolean form.
 */
import { zipPlausibleStates } from '@chrischall/realty-core';

export {
  zipPlausibleStates,
  extractZipFromLocation,
  FIRST_DIGIT_TO_STATES,
} from '@chrischall/realty-core';

/**
 * Quick check: do the returned homes' states match the ZIP-derived
 * expected states? Returns `matched: null` when we can't make a
 * determination (non-US ZIP, no homes, empty states). Returns
 * `matched: false` only when we are CONFIDENT the result doesn't match.
 *
 * Built on realty-core's `zipPlausibleStates`; the `{ plausibleStates,
 * matched }` shape is redfin-specific — the search guard surfaces the
 * plausible-state set in its cross-continent-fallback error message.
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
