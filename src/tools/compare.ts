import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { BRIDGE_CONCURRENCY } from '@chrischall/mcp-utils/fetchproxy';
import { runBoundedBatch } from '@chrischall/mcp-utils';
import type { RedfinClient } from '../client.js';
import { viewArg, viewResponse } from '../view.js';
import type { FormattedProperty } from './properties.js';
import {
  OVERALL_DEADLINE_MS,
  fetchPropertyRow,
  pendingPropertyRow,
  type BulkGetTuning,
  type BulkPerProperty,
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

type ComparePerProperty = Pick<
  BulkPerProperty,
  'property_id' | 'url' | 'property' | 'error'
> &
  Partial<Pick<BulkPerProperty, 'status' | 'retryable'>>;

export function buildSummary(rows: ComparePerProperty[]): CompareSummaryRow[] {
  const pick = (
    label: string,
    fn: (p: FormattedProperty) => number | string | null | undefined
  ): CompareSummaryRow => ({
    field: label,
    values: rows.map((r) => (r.property ? fn(r.property) ?? null : null)),
  });
  // Summary fields match the per-row property shape exactly — same
  // primitive type, same null semantics. No JSON-stringified compound
  // values; that was the onehome bug class #37 tracks.
  return [
    pick('price', (p) => p.price),
    pick('price_per_sqft', (p) => p.price_per_sqft),
    pick('price_drop_amount', (p) => p.price_drop_amount),
    pick('price_drop_percent', (p) => p.price_drop_percent),
    pick('beds', (p) => p.beds),
    pick('baths', (p) => p.baths),
    pick('sqft', (p) => p.sqft),
    pick('lot_size', (p) => p.lot_size),
    pick('lot_size_acres', (p) => p.lot_size_acres),
    pick('year_built', (p) => p.year_built),
    pick('status', (p) => p.status),
    pick('cumulative_days_on_market', (p) => p.cumulative_days_on_market),
    pick('hoa_monthly_usd', (p) => p.hoa_monthly_usd),
    pick('tax_annual', (p) => p.tax_annual),
    pick('last_sold_price', (p) => p.last_sold_price),
    pick('last_sold_date', (p) => p.last_sold_date),
    pick('city', (p) => p.city),
    pick('zip', (p) => p.zip),
  ];
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
      const results: ComparePerProperty[] = await runBoundedBatch<
        CompareTarget,
        BulkPerProperty
      >(
        targets as CompareTarget[],
        (t, signal) =>
          fetchPropertyRow(
            client,
            t,
            include_description === true,
            signal,
            'compare_properties'
          ),
        {
          deadlineMs: overallDeadlineMs,
          concurrency: BRIDGE_CONCURRENCY,
          onTimeout: (t) => pendingPropertyRow(t, 'compare_properties'),
        }
      );
      const pending = results.filter((r) => r.status === 'pending').length;
      return viewResponse(view, {
        count: results.length,
        ...(pending > 0 ? { pending } : {}),
        ...(include_summary === true ? { summary: buildSummary(results) } : {}),
        results,
      });
    }
  );
}
