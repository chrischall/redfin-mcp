import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { resolveAddress } from '../autocomplete.js';

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
        "Resolve a free-text address (with optional city/state/zip) to its Redfin canonical home URL and home_id. Hits the autocomplete endpoint and returns the first Addresses match. Degrades to `resolved: false` when no listing is found — does not throw. Use this when you have a property address and need its Redfin home_id for follow-on calls (e.g. `redfin_get_property`). Read-only, no auth required.",
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
      const query = [input.address, input.city, input.state, input.zip]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join(' ');
      const match = await resolveAddress(client, query);
      if (!match) {
        return textResult({
          resolved: false,
          query,
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
      });
    }
  );
}
