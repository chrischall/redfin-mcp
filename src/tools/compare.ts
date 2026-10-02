import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { RedfinClient } from '../client.js';
import { viewArg, viewResponse } from '../view.js';
import type { FormattedProperty } from './properties.js';
import { pivotSummary } from '@chrischall/realty-core';
import {
  OVERALL_DEADLINE_MS,
  runPropertyRows,
  type BulkGetTuning,
} from './bulk-get.js';

/**
 * Side-by-side comparison of N Redfin properties. Each property goes
 * through the same bounded pipeline as `redfin_bulk_get`
 * (fleet-audit #220): `runBoundedBatch` with {@link BRIDGE_CONCURRENCY}
 * targets in flight, retry-once-on-timeout per row, and an overall
 * deadline that turns a hung row into a retryable `pending` row instead
 * of wedging the call. It used to be an unbounded `Promise.all` — up to
 * 25 targets × (initialInfo + ATF + BTF) at once through the user's
 * signed-in tab. Errors for any single property are captured per-row so
 * a partial comparison still works.
 */

export type CompareTuning = BulkGetTuning;

export interface CompareSummaryRow {
  field: string;
  values: Array<number | string | null>;
}

type ComparePerProperty = {
  property_id?: number;
  url: string;
  property?: FormattedProperty;
};

export function buildSummary(
  rows: ReadonlyArray<ComparePerProperty>
): CompareSummaryRow[] {
  // realty-core `pivotSummary` (fleet-audit#1091): summary fields match the
  // per-row property shape exactly — same primitive type, same null
  // semantics (#37) — `undefined` / failed row → null.
  return pivotSummary<FormattedProperty>(rows, [
    'price',
    'price_per_sqft',
    'price_drop_amount',
    'price_drop_percent',
    'beds',
    'baths',
    'sqft',
    'lot_size',
    'lot_size_acres',
    'year_built',
    'status',
    'cumulative_days_on_market',
    'hoa_monthly_usd',
    'tax_annual',
    'last_sold_price',
    'last_sold_date',
    'city',
    'zip',
  ]) as CompareSummaryRow[];
}

interface CompareTarget {
  url?: string;
  property_id?: number;
  listing_id?: number;
}

export function registerCompareTools(
  server: McpServer,
  client: RedfinClient,
  tuning: CompareTuning = {}
): void {
  const overallDeadlineMs = tuning.overallDeadlineMs ?? OVERALL_DEADLINE_MS;
  server.registerTool(
    'redfin_compare_properties',
    {
      title: 'Compare multiple Redfin properties side-by-side',
      description:
        "Fetch and compare 2 to 25 Redfin properties side-by-side. Provide an array of targets, each either a `url` or a `property_id`+`listing_id` pair. Returns the full per-property record (price, beds/baths, sqft, year built, HOA monthly, last sold, derived price-drop, etc.). For >25 properties or workflows that don't need side-by-side analysis use `redfin_bulk_get`. Pass `include_summary: true` for an aligned-by-field `summary` table (default false to save context — the per-row records carry the same data, so emitting both duplicates ~30% of the response weight). Each record's `extracted_features` (lake_front, hot_tub, basement, furnished, dock, community) is always included. The raw marketing description is omitted by default — opt in with `include_description: true`. Errors for individual properties are captured per-row with a `status` (`ok` / `timeout` / `bridge_down` / `protocol` / `pending` / `other`) and `retryable`. Server-side concurrency (~6 in flight) with retry-once-on-timeout per row; the whole call is bounded by an overall deadline, and any row still unsettled then comes back as `status: \"pending\"` (retryable) with a `pending` count.",
      annotations: {
        title: 'Compare multiple Redfin properties side-by-side',
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
                url: z.string().optional(),
                property_id: z.number().int().positive().optional(),
                listing_id: z.number().int().positive().optional(),
              })
              .refine(
                (v) => !!v.url || (!!v.property_id && !!v.listing_id),
                'each target needs url, or property_id+listing_id'
              )
          )
          .min(2)
          .max(25)
          .describe('Array of 2–25 properties to compare. Use `redfin_bulk_get` for larger batches that don\'t need side-by-side analysis.'),
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include each property\'s raw marketing/public-remarks description. Default false to save context — `extracted_features` always carries the structured signal.'
          ),
        include_summary: z
          .boolean()
          .optional()
          .describe(
            'Include the aligned-by-field `summary` table. Default false — the per-row records carry the same data, so emitting both duplicates ~30% of the response weight. (#37)'
          ),
      }),
    },
    async ({ targets, include_description, include_summary, view }) => {
      const envelope = await runPropertyRows(client, targets as CompareTarget[], {
        includeDescription: include_description === true,
        deadlineMs: overallDeadlineMs,
        toolLabel: 'redfin_compare_properties',
      });
      return viewResponse(
        view,
        include_summary === true
          ? { ...envelope, summary: buildSummary(envelope.results) }
          : envelope
      );
    }
  );
}
