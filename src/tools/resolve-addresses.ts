import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  mapWithConcurrency,
} from '@chrischall/mcp-utils/fetchproxy';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  createLocalityPoolCache,
  resolveAddressWithFallbacks,
  type LocalityPoolCache,
} from '../resolve.js';

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
  /** Which rung surfaced the match (`'autocomplete'` or
   * `'search_fallback'`, #75). Present only on resolved rows. */
  matched_via?: 'autocomplete' | 'search_fallback';
  /** Variant that actually matched (only populated when a fallback
   * variant — e.g. suffix-expanded `Rd` → `Road` — caught a row the
   * as-typed query missed). Mirrors the field on `redfin_get_by_address`
   * so bulk callers can see WHICH form Redfin recognized. */
  matched_variant?: string;
  error?: string;
}

/** Normalize either input shape to the shared `AddressParts` form. */
function inputToParts(input: AddressInput): {
  street: string;
  city?: string;
  state?: string;
  zip?: string;
} {
  if (typeof input === 'string') return { street: input };
  return {
    street: input.street,
    city: input.city,
    state: input.state,
    zip: input.zip,
  };
}

async function resolveOne(
  client: RedfinClient,
  input: AddressInput,
  pool?: LocalityPoolCache
): Promise<ResolvedAddressRow> {
  const parts = inputToParts(input);
  try {
    // Shared with `redfin_get_by_address`. Both tools run the same
    // fallback rungs (autocomplete + suffix expansion + search fallback)
    // so bulk callers see the same hit rate as the single tool. See
    // #71 (parity audit) and #75 (search-fallback rung). The shared
    // `pool` memoizes the search-fallback rung's region lookup + ~350-home
    // gis pull across same-locality rows, so a same-city batch does one
    // region lookup + one gis pull instead of N of each.
    const { match, attempts, matchedVariant, matchedVia } =
      await resolveAddressWithFallbacks(client, parts, { pool });
    const query = attempts[0] ?? parts.street;
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
      matched_via: matchedVia,
      // Same convention as the single tool: only surface the variant
      // when it's something OTHER than the as-typed query.
      ...(matchedVariant && matchedVariant !== query
        ? { matched_variant: matchedVariant }
        : {}),
    };
  } catch (e) {
    const fallbackQuery =
      typeof input === 'string'
        ? input
        : [input.street, input.city, input.state, input.zip]
            .filter((s): s is string => Boolean(s && s.trim()))
            .join(' ');
    return {
      input,
      query: fallbackQuery,
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
      // One pool cache for the whole batch — memoizes the search-fallback
      // rung's per-locality region lookup + gis pull so a same-city batch
      // collapses to one region lookup + one gis pull total.
      const pool = createLocalityPoolCache();
      const results = await mapWithConcurrency(
        addresses as AddressInput[],
        BRIDGE_CONCURRENCY,
        (a) => resolveOne(client, a, pool)
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
