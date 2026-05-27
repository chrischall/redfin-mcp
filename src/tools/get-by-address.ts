import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { resolveAddress, type RedfinAddress } from '../autocomplete.js';
import { expandAddressVariants } from '../suffix.js';

/**
 * `redfin_get_by_address`: resolve a free-text address to a Redfin
 * canonical home URL + home_id.
 *
 * Implementation: hit `/stingray/do/location-autocomplete` once with
 * the address joined into a single query string. Look at the
 * `Addresses` section. The first row carries the canonical home URL
 * (e.g. `/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221`); we parse
 * it for `home_id` and return both. Degrades to `resolved: false`
 * when no Addresses row comes back.
 *
 * This is the cleanest entry point for "I have an address; what's its
 * Redfin home_id?" — one round-trip, no gis fallback, no region
 * lookup. Use `redfin_get_property` afterward if you need the full
 * property record.
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
        "Resolve a free-text address (with optional city/state/zip) to its Redfin canonical home URL and home_id. Hits the autocomplete endpoint and returns the first Addresses match. Degrades to `resolved: false` when no listing is found — does not throw. KNOWN GOTCHA: Redfin's autocomplete is strict about the upstream canonical street-suffix form (`Road` vs `Rd`, `Lane` vs `Ln`, etc.) — `268 Mallard Rd` may miss while `268 Mallard Road` resolves. Companion issue #43 tracks an abbreviation-expansion retry; until that lands, callers should try both forms on a miss. Address discrepancies across MLS feeds are common (the `109 vs 169 Overlook Point Ln` cross-MLS case is a regular occurrence) — companion `address_alternates[]` field (#42) surfaces conflicts when present. Use this when you have a property address and need its Redfin home_id for follow-on calls (e.g. `redfin_get_property`). Read-only, no auth required.",
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
      // Build the canonical query, then expand suffix variants on the
      // STREET PORTION ONLY. The first variant is the input as-typed;
      // alternates swap the street-suffix between abbreviated and
      // full forms. We try them in order and stop on the first hit.
      // (#43 — `268 Mallard Rd` didn't resolve, `268 Mallard Road` did.)
      const cityStateZip = [input.city, input.state, input.zip]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join(' ');
      const addressVariants = expandAddressVariants(input.address);
      const candidates = addressVariants.map((a) =>
        cityStateZip ? `${a} ${cityStateZip}` : a
      );
      // Top-level query used for response payload + error case logging.
      const query = candidates[0] ?? input.address;
      const attempts: string[] = [];
      let match: RedfinAddress | null = null;
      let matchedVariant: string | undefined;
      for (const variant of candidates) {
        attempts.push(variant);
        // Pass each variant through autocomplete. Wrap individual
        // failures so one bad candidate doesn't kill the loop.
        try {
          match = await resolveAddress(client, variant);
        } catch {
          match = null;
        }
        if (match) {
          matchedVariant = variant;
          break;
        }
      }
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
