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
 * Uses a STRICT-MAJORITY threshold rather than an any-one-match test: a
 * result set is considered matched only when more than half of the
 * (non-null) home states fall in the ZIP's plausible-state set. This
 * mirrors the spirit of the homes-cohort silent-fallback guard
 * (`assertRegionMatches`) — a single in-state home among a Seattle-heavy
 * set is a poisoned cross-continent fallback (#46), not a legitimate
 * match, so it must not flip the verdict to matched. A clean result with
 * one stray out-of-state row still clears the majority and stays matched.
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
  // Count per-home (not per-distinct-state): the threshold is "majority
  // of the returned homes", so three WA homes outvote one NC home.
  let total = 0;
  let inState = 0;
  for (const s of homeStates) {
    if (!s) continue;
    total++;
    if (plausible.has(s.toUpperCase())) inState++;
  }
  if (total === 0) return { plausibleStates: plausible, matched: null };
  // Strict majority: more than half of the homes must be state-plausible.
  const matched = inState * 2 > total;
  return { plausibleStates: plausible, matched };
}
