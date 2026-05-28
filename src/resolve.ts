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
 */
import type { RedfinClient } from './client.js';
import { resolveAddress, type RedfinAddress } from './autocomplete.js';
import { expandAddressVariants } from './suffix.js';

export interface AddressParts {
  /** Required free-text street ("158 Raven Blvd" or "158 Raven Blvd Lake Lure NC 28746"). */
  street: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface ResolveResult {
  /** The resolved address, or null if every variant missed. */
  match: RedfinAddress | null;
  /** Every query string tried, in attempt order. Useful for debugging misses. */
  attempts: string[];
  /** The variant string that actually matched. Undefined when nothing matched. */
  matchedVariant?: string;
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

/**
 * Walk the variants in order, hitting Redfin autocomplete once per
 * variant. Stop on the first hit. `resolveAddress` returns null for
 * "no match" (drives fallthrough) and throws for real errors
 * (auth/WAF/network) — those propagate to the caller.
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
      return { match, attempts, matchedVariant: variant };
    }
  }
  return { match: null, attempts };
}
