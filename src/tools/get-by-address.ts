import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { resolveAddressWithFallbacks } from '../resolve.js';

/**
 * `redfin_get_by_address`: resolve a free-text address to a Redfin
 * canonical home URL + home_id.
 *
 * Implementation walks the shared rung ladder in `resolveAddressWithFallbacks`:
 *   1. autocomplete (input as-typed)
 *   2. autocomplete (suffix-expansion: Rd ↔ Road, etc.)
 *   3. search fallback (#75) — when autocomplete misses entirely and
 *      locality info is provided, resolve the city/state to a region,
 *      fire a gis search bounded by that region, and fuzzy-match
 *      returned home rows against the input street's tokens.
 *
 * Degrades to `resolved: false` when every rung misses. `matched_via`
 * surfaces which rung resolved the address ('autocomplete' or
 * 'search_fallback') so callers can see whether they hit the direct
 * path or the broader search-bounded fallback. Use
 * `redfin_get_property` afterward if you need the full property record.
 */

export function registerGetByAddressTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_by_address',
    {
      title: 'Resolve an address to its Redfin canonical URL + home_id',
      description:
        "Resolve a free-text address (with optional city/state/zip) to its Redfin canonical home URL and home_id. Walks a 3-rung ladder: (1) autocomplete as-typed, (2) autocomplete with suffix expansion (Rd ↔ Road, Ln ↔ Lane, etc.), (3) search fallback (#75) — when autocomplete misses entirely and city/state are provided, resolves the locality to a region, fires a bounded gis search, and fuzzy-matches the input street tokens against returned homes. `matched_via` is `'autocomplete'` or `'search_fallback'`. Degrades to `resolved: false` when every rung misses — does not throw. Address discrepancies across MLS feeds are common (the `109 vs 169 Overlook Point Ln` cross-MLS case is a regular occurrence) — companion `address_alternates[]` field (#42) surfaces conflicts when present. Use this when you have a property address and need its Redfin home_id for follow-on calls (e.g. `redfin_get_property`). Read-only, no auth required.",
      annotations: {
        title: 'Resolve an address to its Redfin canonical URL + home_id',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        address: z
          .string()
          .describe('Street address (e.g. "158 Raven Blvd").'),
        city: z.string().optional().describe('City name (e.g. "Lake Lure").'),
        state: z
          .string()
          .optional()
          .describe('Two-letter state code (e.g. "NC").'),
        zip: z.string().optional().describe('ZIP code (e.g. "28746").'),
      },
    },
    async (input) => {
      // Delegate the rung-walking (autocomplete + suffix-expansion +
      // search-fallback) to the shared `resolveAddressWithFallbacks`
      // helper. Both `redfin_get_by_address` and `redfin_resolve_addresses`
      // call this same helper so the fallback strategy stays in sync.
      // See issue #71 (parity audit) and #75 (search-fallback rung).
      const { match, attempts, matchedVariant, matchedVia } =
        await resolveAddressWithFallbacks(client, {
          street: input.address,
          city: input.city,
          state: input.state,
          zip: input.zip,
        });
      const query = attempts[0] ?? input.address;
      if (!match) {
        return textResult({
          resolved: false,
          query,
          attempts,
        });
      }
      return textResult({
        resolved: true,
        url: match.url,
        home_id: match.home_id,
        street_address: match.street_address,
        city: match.city,
        state: match.state,
        zip: match.zip,
        // Which rung surfaced the match — `'autocomplete'` or
        // `'search_fallback'` (#75). Always present on success so
        // callers can tell whether they hit the direct path or the
        // gis-search fallback.
        matched_via: matchedVia,
        // When the input as-typed matched, omit the variant signal —
        // the common case stays terse. When a suffix-swap variant
        // matched, surface it so the caller can record which form
        // Redfin recognized.
        ...(matchedVariant && matchedVariant !== query
          ? { matched_variant: matchedVariant }
          : {}),
      });
    }
  );
}
