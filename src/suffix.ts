/**
 * Street-suffix abbreviation expansion for address resolution
 * retries. Redfin's autocomplete is strict about the upstream
 * canonical form — `268 Mallard Rd` doesn't resolve in 28746 even
 * though Redfin clearly has the listing as `268 Mallard Road`.
 * (See issue #43, real-session regression.)
 *
 * The suffix-swap math (USPS Pub 28 Appendix C2 pairs + the
 * remainder-preserving last-token swap) now lives canonically in
 * `@chrischall/realty-core` as `expandSuffix` — surveyed directly from
 * this file during the cohort migration (realty-mcp#1). We keep the thin
 * redfin-specific wrappers here:
 *
 *   - `expandAddressVariants(address)` — the input PLUS the suffix-swap
 *     alternates (realty-core's `expandSuffix` returns ONLY the
 *     alternates), original-first, deduped. This is the contract redfin's
 *     resolve ladder (`src/resolve.ts`) depends on.
 *   - `listVariants(address)` — `{ primary, alternates }` split.
 *
 * NOTE: we deliberately do NOT adopt realty-core's richer
 * `buildVariants` (which also emits compound split/join variants like
 * "Bluebird" ↔ "Blue Bird"). redfin's resolve ladder + the
 * search-fallback rung are tuned to the suffix-only variant set; adding
 * compound splits is a separate resolve-tuning change, not part of this
 * mechanical hoist. The expanded SUFFIX_PAIRS (canonical added
 * `Hts/Mt/Pkw/Cr`) come along for free via `expandSuffix`.
 */
import { expandSuffix } from '@chrischall/realty-core';

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
  for (const v of expandSuffix(address)) push(v);
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
