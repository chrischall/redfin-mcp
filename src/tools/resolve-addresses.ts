import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from '@chrischall/mcp-utils/fetchproxy';
import { runBoundedBatch } from '@chrischall/mcp-utils';
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

/**
 * Overall hard deadline (ms) for the whole `redfin_resolve_addresses`
 * call. Same wedge class as the bulk-get deadline (issue #98): a single
 * hung row with no shorter effective deadline can wedge the MCP
 * connection into a `-32001 Request timed out`. Capped comfortably below
 * the ~60s client timeout, matching the cohort 45-50s convention.
 */
const OVERALL_DEADLINE_MS = 45_000;

/**
 * `classifyRowError` row-error kinds, plus `pending` for an
 * overall-deadline cut. `'ok'` is implied by `resolved: true`. These are
 * surfaced as a machine-readable `status` so a bridge timeout is never
 * mistaken for a genuine no-match (D2, the #78 bug class).
 */
type ResolveRowStatus =
  | 'timeout'
  | 'bridge_down'
  | 'protocol'
  | 'pending'
  | 'other';

/** Statuses where re-issuing the same row could plausibly succeed. */
const RETRYABLE_ROW_KINDS = new Set<ResolveRowStatus>([
  'timeout',
  'bridge_down',
  'pending',
]);

/**
 * Tuning knobs. Tests inject a tiny `overallDeadlineMs` so the suite
 * doesn't wait on real wall-clock.
 */
export interface ResolveAddressesTuning {
  /**
   * Overall hard deadline (ms) for the whole call. When it fires, any
   * row that hasn't settled is backfilled with `status: 'pending'`
   * (retryable) and the call resolves with partial results rather than
   * hanging. Defaults to {@link OVERALL_DEADLINE_MS}.
   */
  overallDeadlineMs?: number;
}

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
  /**
   * Machine-readable error classification (D2). Present only on
   * unresolved rows that failed (not on a clean `resolved: false` miss):
   * a bridge `timeout`/`bridge_down`/`pending` must stay distinct from a
   * genuine no-match so the caller never records a real property as
   * absent (the #78 bug class).
   */
  status?: ResolveRowStatus;
  /**
   * Whether re-issuing this exact row could plausibly succeed. Set
   * alongside `status` on transient-failure rows.
   */
  retryable?: boolean;
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
    //
    // Wrapped in retryOnceOnTimeout (#78): a single FetchproxyTimeoutError
    // inside the resolver ladder retries the whole ladder once before
    // bubbling up. Any other error class bubbles immediately — only a
    // transient bridge hiccup gets a second chance.
    const { match, attempts, matchedVariant, matchedVia } =
      await retryOnceOnTimeout(() =>
        resolveAddressWithFallbacks(client, parts, { pool })
      );
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
    // D2 (#78 bug class): a bridge timeout that survives the retry MUST
    // surface distinctly. Previously this captured `(e as Error).message`
    // with no classification, so a timeout was indistinguishable from a
    // genuine no-match (`resolved: false`) — the reporter nearly recorded
    // real properties as absent. classifyRowError gives the discriminator
    // + the canonical wrapper string.
    const { kind, message } = classifyRowError(e);
    return {
      input,
      query: fallbackQuery,
      resolved: false,
      status: kind,
      retryable: RETRYABLE_ROW_KINDS.has(kind),
      error: message,
    };
  }
}

export function registerResolveAddressesTools(
  server: McpServer,
  client: RedfinClient,
  tuning: ResolveAddressesTuning = {}
): void {
  const overallDeadlineMs = tuning.overallDeadlineMs ?? OVERALL_DEADLINE_MS;
  server.registerTool(
    'redfin_resolve_addresses',
    {
      title: 'Bulk-resolve street addresses to Redfin URLs + home_ids',
      description:
        "Resolve up to 100 free-text street addresses to Redfin canonical home URLs + home_ids in a single tool call. Each input is either a string (full address) or a structured `{street, city, state, zip}` object. Output preserves input order. Unresolved entries return `resolved: false` without aborting the batch; a transient bridge failure surfaces a distinct retryable `status` (timeout/bridge_down/pending) so it is never mistaken for a genuine no-match. Per-row retry-once-on-timeout, server-side concurrency ~6 in flight. The whole call is bounded by an overall hard deadline: a single slow/hung row never wedges the server — unsettled rows come back with `status: \"pending\"` and a `pending` count so you can re-run just those. Use this when you have a list of properties from another system (Compass, MLS, spreadsheet) and need their Redfin handles for follow-on calls — collapses the typical 6-search-call + 15-resolve flow into one trip.",
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
      const inputs = addresses as AddressInput[];

      // `runBoundedBatch` (mcp-utils 0.8, hoisted from exactly this pattern):
      // index-addressable slots + an overall hard deadline (D2) +
      // concurrency-bounded fan-out, returning one row per input in input
      // order. When the deadline fires, every still-unsettled slot is filled
      // by `onTimeout` (a retryable `pending` row) and the in-flight workers
      // are abandoned — so a single permanently-hung row can't wedge the
      // connection past the bound. `resolveOne` already catches per-row
      // errors and returns a `resolved: false` row, so the batch never
      // rejects; the default `onError` (→ `onTimeout`) only guards the
      // unreachable throw case.
      const results = await runBoundedBatch<AddressInput, ResolvedAddressRow>(
        inputs,
        (input) => resolveOne(client, input, pool),
        {
          deadlineMs: overallDeadlineMs,
          concurrency: BRIDGE_CONCURRENCY,
          // A deadline-cut row is unresolved BUT retryable — never a silent
          // `resolved: false` miss.
          onTimeout: (input): ResolvedAddressRow => {
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
              status: 'pending',
              retryable: true,
              error:
                'resolve_addresses overall deadline reached before this row ' +
                'settled — the request is still pending (likely a slow/hung ' +
                'sub-request). Re-run just the pending addresses; a single ' +
                'slow row no longer wedges the batch.',
            };
          },
        }
      );

      const ok = results.filter((r) => r.resolved).length;
      const unresolved = results.length - ok;
      const pending = results.filter((r) => r.status === 'pending').length;
      const envelope: {
        count: number;
        resolved: number;
        unresolved: number;
        pending?: number;
        results: ResolvedAddressRow[];
      } = { count: results.length, resolved: ok, unresolved, results };
      if (pending > 0) envelope.pending = pending;
      return textResult(envelope);
    }
  );
}
