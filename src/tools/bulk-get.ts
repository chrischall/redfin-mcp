import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  mapWithConcurrency,
  retryOnceOnTimeout,
  withDeadline,
} from '@chrischall/mcp-utils/fetchproxy';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  fetchAndFormatProperty,
  type FormattedProperty,
} from './properties.js';

/**
 * `redfin_bulk_get`: unbounded structured fetch for many properties in
 * a single tool call. Designed for "I have 50 saved homes, give me
 * everything" workflows that today require sequential
 * `redfin_compare_properties` rounds (8-property cap each).
 *
 * Each target can be a URL or a property_id+listing_id pair. Per-target
 * errors are captured per-row so a single bad ID doesn't fail the
 * batch. ATF + BTF are fetched in parallel per target (same pipeline
 * as get_property), and targets themselves are fanned out concurrently
 * via `mapWithConcurrency` from `@chrischall/mcp-utils/fetchproxy` (cap pinned at
 * {@link BRIDGE_CONCURRENCY}=6 — the round-3 cohort comparison value)
 * to avoid hammering Redfin.
 *
 * Hard cap: 200 targets per call. See issue #38.
 */

const MAX_TARGETS = 200;

/**
 * Overall hard deadline (ms) for the whole `redfin_bulk_get` call. The
 * MCP SDK gives each tool call a finite request deadline (commonly 60s);
 * a single hung row with no shorter effective deadline wedges the
 * connection into a `-32001 Request timed out` AND can keep the server
 * busy afterward. We cap the whole batch comfortably below that so a
 * slow/hanging row turns into a `pending`-marked partial result instead
 * of a wedge. Tuned to ~45s, matching zillow's `OVERALL_DEADLINE_MS`
 * (issue #98) and the cohort 45-50s convention.
 */
const OVERALL_DEADLINE_MS = 45_000;

/**
 * Tuning knobs. Defaults are the production values; tests inject a tiny
 * `overallDeadlineMs` so the suite doesn't wait on real wall-clock.
 */
export interface BulkGetTuning {
  /**
   * Overall hard deadline (ms) for the whole call. When it fires, any
   * row that hasn't settled is backfilled with `status: 'pending'`
   * (retryable) and the call resolves with partial results rather than
   * hanging. Defaults to {@link OVERALL_DEADLINE_MS}.
   */
  overallDeadlineMs?: number;
}

interface BulkTarget {
  url?: string;
  property_id?: number;
  listing_id?: number;
}

/**
 * Per-row outcome status. `'ok'` for a fetched property; `'pending'`
 * when the overall deadline cut the row off before it settled; otherwise
 * the `classifyRowError` kind so the cohort's "20-of-20 with X timeouts"
 * summary reporting can branch without re-parsing the message string.
 */
type BulkRowStatus =
  | 'ok'
  | 'timeout'
  | 'bridge_down'
  | 'protocol'
  | 'pending'
  | 'other';

interface BulkPerProperty {
  property_id?: number;
  url: string;
  /** Row outcome. Always present so callers never infer it from `error`. */
  status: BulkRowStatus;
  property?: FormattedProperty;
  error?: string;
  /**
   * Whether re-issuing this exact row could plausibly succeed. Only set
   * on error rows — `'timeout'`/`'bridge_down'` are transient bridge
   * conditions (true); `'protocol'`/`'other'` (including a genuine "no
   * listing found" miss) are not (false).
   */
  retryable?: boolean;
}

/**
 * `classifyRowError` kinds that are transient bridge conditions worth a
 * caller-side retry. `protocol` (no_tab / domain_denied) and `other`
 * (genuine misses, programmer errors) are structural — re-issuing the
 * same row won't change the outcome. `pending` (an overall-deadline cut)
 * is transient too — the row never settled, so a re-run can succeed.
 */
const RETRYABLE_ROW_KINDS = new Set(['timeout', 'bridge_down', 'pending']);

async function fetchOne(
  client: RedfinClient,
  t: BulkTarget,
  includeDescription: boolean
): Promise<BulkPerProperty> {
  try {
    // Shared resolveIds → parallel ATF/BTF → format pipeline (same one
    // get_property + compare_properties use). Wrapped in retryOnceOnTimeout
    // (#78/D3) so a single FetchproxyTimeoutError — the rotating-tab /
    // SW-eviction tax that hits the first request to a stale tab — gets one
    // retry before the row fails, matching zillow/homes/onehome.
    const { ids, canonicalUrl, property } = await retryOnceOnTimeout(() =>
      fetchAndFormatProperty(client, t, { includeDescription })
    );
    return {
      property_id: ids.propertyId,
      url: canonicalUrl,
      status: 'ok',
      property,
    };
  } catch (e) {
    // Swap the old ad-hoc `(e as Error).message` wrap for the cohort's
    // typed classifier (fetchproxy 0.10.0). It hands back both the kind
    // — so the batch summary can keep timeouts distinguishable from a
    // genuine "no listing found" miss (round-3 #78) — and the
    // standardized user-facing message string the cohort settled on.
    const { kind, message } = classifyRowError(e);
    return {
      property_id: t.property_id,
      url: t.url ?? '',
      status: kind,
      retryable: RETRYABLE_ROW_KINDS.has(kind),
      error: message,
    };
  }
}

export function registerBulkGetTools(
  server: McpServer,
  client: RedfinClient,
  tuning: BulkGetTuning = {}
): void {
  const overallDeadlineMs = tuning.overallDeadlineMs ?? OVERALL_DEADLINE_MS;
  server.registerTool(
    'redfin_bulk_get',
    {
      title: 'Bulk fetch Redfin property records',
      description:
        "Fetch up to 200 Redfin property records in a single tool call. Provide an array of targets, each one of: a `url` (full Redfin homedetails URL or path with the /home/<id> segment), a `property_id` alone (resolved internally by following Redfin's /home/<id> redirect to the canonical listing), or a `property_id`+`listing_id` pair (fastest — skips resolution). Returns the same per-property record shape as `redfin_get_property`, but without a summary table — use `redfin_compare_properties` for that. Per-target errors are captured per-row; a single bad ID does not fail the batch. Server-side concurrency, ~6 in flight at a time, with retry-once-on-timeout per row to absorb transient bridge hiccups. The whole call is bounded by an overall hard deadline: a single slow/hung row never wedges the server — when the deadline is reached any unsettled row is returned with `status: \"pending\"` (retryable) and a `pending` count so you can re-run just those targets. Use this when you have a list of saved homes / candidate properties and need the full structured data for every one of them.",
      annotations: {
        title: 'Bulk fetch Redfin property records',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        targets: z
          .array(
            z
              .object({
                url: z
                  .string()
                  .optional()
                  .describe(
                    'Redfin homedetails URL or path including the /home/<id> segment.'
                  ),
                property_id: z
                  .number()
                  .int()
                  .positive()
                  .optional()
                  .describe(
                    'Numeric Redfin property ID. Sufficient on its own — when no listing_id/url is given it is resolved internally via the /home/<id> redirect. Pair with listing_id to skip that resolve.'
                  ),
                listing_id: z
                  .number()
                  .int()
                  .positive()
                  .optional()
                  .describe('Numeric Redfin listing ID. Optional; pairs with property_id to skip resolution.'),
              })
              .refine(
                (v) => !!v.url || !!v.property_id,
                'each target needs a url, a property_id alone, or a property_id+listing_id pair'
              )
          )
          .min(1)
          .max(MAX_TARGETS)
          .describe(`Array of 1–${MAX_TARGETS} properties to fetch`),
        include_description: z
          .boolean()
          .optional()
          .describe(
            "Include each property's raw marketing/public-remarks description. Default false to save context — `extracted_features` always carries the structured signal."
          ),
      },
    },
    async ({ targets, include_description }) => {
      const targetList = targets as BulkTarget[];

      // Index-addressable result slots, one per input target. A slot stays
      // `undefined` until its fetch settles; if the overall deadline fires
      // first (D1), every still-undefined slot is backfilled with a
      // `pending` marker so the response always has exactly one row per
      // input, in input order — and the call returns partial results
      // instead of hanging for the full client timeout.
      const slots: Array<BulkPerProperty | undefined> = targetList.map(
        () => undefined
      );
      const indexed = targetList.map((target, index) => ({ target, index }));

      const runAll = mapWithConcurrency<
        { target: BulkTarget; index: number },
        void
      >(indexed, BRIDGE_CONCURRENCY, async ({ target, index }) => {
        slots[index] = await fetchOne(
          client,
          target,
          include_description === true
        );
      });

      // Race the whole batch against the overall hard deadline (D1). On
      // expiry the in-flight `runAll` promise is abandoned (left to settle
      // in the background and ignored) — critically, we do NOT await it, so
      // a permanently-hung row can't wedge the connection.
      await withDeadline(runAll, overallDeadlineMs);

      // Backfill any slot the deadline cut off as a retryable `pending`
      // row. The identity comes from the original target so the row stays
      // re-runnable; a `pending` row is NEVER a generic miss / not-found.
      const results: BulkPerProperty[] = slots.map((row, index) => {
        if (row) return row;
        const target = targetList[index];
        return {
          property_id: target.property_id,
          url: target.url ?? '',
          status: 'pending',
          retryable: true,
          error:
            'bulk_get overall deadline reached before this row settled — ' +
            'the request is still pending (likely a slow/hung sub-request). ' +
            'Re-run just the pending targets; a single slow row no longer ' +
            'wedges the batch.',
        };
      });

      const ok = results.filter((r) => r.status === 'ok').length;
      const errored = results.length - ok;
      const pending = results.filter((r) => r.status === 'pending').length;
      const envelope: {
        count: number;
        ok: number;
        errored: number;
        pending?: number;
        results: BulkPerProperty[];
      } = { count: results.length, ok, errored, results };
      if (pending > 0) envelope.pending = pending;
      return textResult(envelope);
    }
  );
}
