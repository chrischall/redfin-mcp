import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from '@chrischall/mcp-utils/fetchproxy';
import { runBoundedBatch } from '@chrischall/mcp-utils';
import type { RedfinClient } from '../client.js';
import { runRowBatch } from '@chrischall/realty-core';
import { viewArg, viewResponse } from '../view.js';
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
 * via `runBoundedBatch` from `@chrischall/mcp-utils` (concurrency pinned at
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
export const OVERALL_DEADLINE_MS = 45_000;

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

export interface BulkTarget {
  url?: string;
  property_id?: number;
  listing_id?: number;
}

/**
 * Fetch one property's row fields, throwing on failure. Shared with
 * `redfin_compare_properties` (fleet-audit #220). realty-core's
 * `runRowBatch` (fleet-audit#1091) wraps it: retry-once-on-timeout (#78/D3,
 * the rotating-tab tax), the batch deadline signal checked before every
 * attempt including the retry (#956), and the typed row-error
 * classification — `status` = `error_kind` = the `classifyRowError` kind,
 * `retryable` for `timeout` / `bridge_down` / `pending` — so a timeout
 * stays distinguishable from a genuine "no listing found" miss.
 */
export async function fetchPropertyRow(
  client: RedfinClient,
  t: BulkTarget,
  includeDescription: boolean,
  signal?: AbortSignal
): Promise<{ property_id: number; url: string; property?: FormattedProperty }> {
  const { ids, canonicalUrl, property } = await fetchAndFormatProperty(client, t, {
    includeDescription,
    signal,
  });
  return { property_id: ids.propertyId, url: canonicalUrl, property };
}

/** Run the bulk / compare fan-out through realty-core's `runRowBatch`. */
export function runPropertyRows(
  client: RedfinClient,
  targets: BulkTarget[],
  opts: { includeDescription: boolean; deadlineMs: number; toolLabel: string }
) {
  return runRowBatch(
    targets,
    (t, signal) => fetchPropertyRow(client, t, opts.includeDescription, signal),
    {
      kit: { runBoundedBatch, classifyRowError, retryOnceOnTimeout },
      toolLabel: opts.toolLabel,
      rowBase: (t) => ({ property_id: t.property_id, url: t.url ?? '' }),
      deadlineMs: opts.deadlineMs,
      concurrency: BRIDGE_CONCURRENCY,
    }
  );
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
      inputSchema: z.object({
        view: viewArg(),
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
      }),
    },
    async ({ targets, include_description, view }) => {
      const targetList = targets as BulkTarget[];

      // realty-core `runRowBatch` (fleet-audit#1091): bounded fan-out, an
      // overall hard deadline (D1) with retryable `pending` backfill, one
      // input-ordered row per target, and the
      // `{ count, ok, errored, pending?, results }` envelope.
      const envelope = await runPropertyRows(client, targetList, {
        includeDescription: include_description === true,
        deadlineMs: overallDeadlineMs,
        toolLabel: 'redfin_bulk_get',
      });
      return viewResponse(view, envelope);
    }
  );
}
