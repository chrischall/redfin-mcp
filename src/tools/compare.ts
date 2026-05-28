import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  buildCanonicalUrl,
  format,
  resolveIds,
  type AboveTheFoldPayload,
  type FormattedProperty,
} from './properties.js';

/**
 * Side-by-side comparison of N Redfin properties. Calls `resolveIds` +
 * `aboveTheFold` once per property concurrently, then surfaces a
 * compact summary table aligned by field. Errors for any single
 * property are captured per-row so a partial comparison still works.
 */

export interface CompareSummaryRow {
  field: string;
  values: Array<number | string | null>;
}

interface ComparePerProperty {
  property_id?: number;
  url: string;
  property?: FormattedProperty;
  error?: string;
}

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
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_compare_properties',
    {
      title: 'Compare multiple Redfin properties side-by-side',
      description:
        "Fetch and compare 2 to 25 Redfin properties side-by-side. Provide an array of targets, each either a `url` or a `property_id`+`listing_id` pair. Returns the full per-property record (price, beds/baths, sqft, year built, HOA monthly, last sold, derived price-drop, etc.). For >25 properties or workflows that don't need side-by-side analysis use `redfin_bulk_get`. Pass `include_summary: true` for an aligned-by-field `summary` table (default false to save context — the per-row records carry the same data, so emitting both duplicates ~30% of the response weight). Each record's `extracted_features` (lake_front, hot_tub, basement, furnished, dock, community) is always included. The raw marketing description is omitted by default — opt in with `include_description: true`. Errors for individual properties are captured per-row. Calls are concurrent.",
      annotations: {
        title: 'Compare multiple Redfin properties side-by-side',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
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
      },
    },
    async ({ targets, include_description, include_summary }) => {
      const results = await Promise.all(
        (targets as CompareTarget[]).map(
          async (t): Promise<ComparePerProperty> => {
            try {
              const ids = await resolveIds(client, t);
              const params = new URLSearchParams({
                propertyId: String(ids.propertyId),
                accessLevel: '1',
                listingId: String(ids.listingId),
              });
              // ATF + BTF in parallel: same pattern as redfin_get_property
              // so the derived fields (last_sold_*, tax_annual cleanup)
              // are available without a follow-up fetch.
              const [atfEnv, btf] = await Promise.all([
                client.fetchStingrayJson<AboveTheFoldPayload>(
                  `/stingray/api/home/details/aboveTheFold?${params.toString()}`
                ),
                Promise.resolve(
                  client.fetchStingrayJson<{
                    propertyHistoryInfo?: {
                      events?: Array<{
                        eventDescription?: string;
                        eventDate?: number;
                        price?: number;
                      }>;
                    };
                    publicRecordsInfo?: {
                      basicInfo?: { lotSqFt?: number };
                      taxInfo?: { taxesDue?: number };
                    };
                  }>(
                    `/stingray/api/home/details/belowTheFold?${params.toString()}`
                  )
                )
                  .then((e) => (e ? e.payload ?? null : null))
                  .catch(() => null),
              ]);
              const atf = atfEnv.payload ?? null;
              const initial = ids.initial ?? {
                propertyId: ids.propertyId,
                listingId: ids.listingId,
              };
              const canonicalUrl = t.url
                ? ids.canonicalUrl
                : (buildCanonicalUrl(atf?.addressSectionInfo, ids.propertyId) ?? ids.canonicalUrl);
              return {
                property_id: ids.propertyId,
                url: canonicalUrl,
                property: format(initial, atf, canonicalUrl, {
                  includeDescription: include_description === true,
                  events: btf?.propertyHistoryInfo?.events,
                  taxAnnual: btf?.publicRecordsInfo?.taxInfo?.taxesDue,
                  lotSqFt: btf?.publicRecordsInfo?.basicInfo?.lotSqFt,
                }),
              };
            } catch (e) {
              return {
                property_id: t.property_id,
                url: t.url ?? '',
                error: (e as Error).message,
              };
            }
          }
        )
      );
      return textResult({
        count: results.length,
        ...(include_summary === true ? { summary: buildSummary(results) } : {}),
        results,
      });
    }
  );
}
