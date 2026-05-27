import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { resolveAddress } from '../autocomplete.js';
import { mapWithConcurrency } from './bulk-get.js';

/**
 * `redfin_resolve_addresses`: batch address-resolution for the
 * "I have 60 addresses, get me URLs/home_ids for all of them" workflow.
 * Today that path takes ~6 search calls + ~15 individual resolves +
 * manual matching. A single batch call collapses it to one round trip.
 *
 * Each input is either a free-text address string OR a structured
 * `{street, city, state, zip}` object. Output preserves input order.
 * Per-row failure capture: a single bad address shows `resolved: false`
 * without aborting the rest. See issue #44.
 */

const MAX_ADDRESSES = 100;
const CONCURRENCY = 6;

const AddressInput = z.union([
  z.string(),
  z.object({
    street: z.string(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
  }),
]);

type AddressInput = z.infer<typeof AddressInput>;

interface ResolvedAddressRow {
  input: AddressInput;
  resolved: boolean;
  url?: string;
  home_id?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Free-text query string built from the input — useful when the
   * caller passed a structured input and needs to see what we
   * actually sent to autocomplete. */
  query: string;
  error?: string;
}

function inputToQuery(input: AddressInput): string {
  if (typeof input === 'string') return input;
  return [input.street, input.city, input.state, input.zip]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(' ');
}

async function resolveOne(
  client: RedfinClient,
  input: AddressInput
): Promise<ResolvedAddressRow> {
  const query = inputToQuery(input);
  try {
    const match = await resolveAddress(client, query);
    if (!match) return { input, query, resolved: false };
    return {
      input,
      query,
      resolved: true,
      url: match.url,
      home_id: match.home_id,
      street_address: match.street_address,
      city: match.city,
      state: match.state,
      zip: match.zip,
    };
  } catch (e) {
    return {
      input,
      query,
      resolved: false,
      error: (e as Error).message,
    };
  }
}

export function registerResolveAddressesTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_resolve_addresses',
    {
      title: 'Bulk-resolve street addresses to Redfin URLs + home_ids',
      description:
        "Resolve up to 100 free-text street addresses to Redfin canonical home URLs + home_ids in a single tool call. Each input is either a string (full address) or a structured `{street, city, state, zip}` object. Output preserves input order. Unresolved entries return `resolved: false` without aborting the batch. Server-side concurrency, ~6 in flight at a time. Use this when you have a list of properties from another system (Compass, MLS, spreadsheet) and need their Redfin handles for follow-on calls — collapses the typical 6-search-call + 15-resolve flow into one trip.",
      annotations: {
        title: 'Bulk-resolve street addresses to Redfin URLs + home_ids',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        addresses: z
          .array(AddressInput)
          .min(1)
          .max(MAX_ADDRESSES)
          .describe(
            `Array of 1–${MAX_ADDRESSES} addresses to resolve, each a string or a {street, city, state, zip} object.`
          ),
      },
    },
    async ({ addresses }) => {
      const results = await mapWithConcurrency(
        addresses as AddressInput[],
        CONCURRENCY,
        (a) => resolveOne(client, a)
      );
      const ok = results.filter((r) => r.resolved).length;
      const unresolved = results.length - ok;
      return textResult({
        count: results.length,
        resolved: ok,
        unresolved,
        results,
      });
    }
  );
}
