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
    fn: (p: FormattedProperty) => number | string | undefined
  ): CompareSummaryRow => ({
    field: label,
    values: rows.map((r) => (r.property ? fn(r.property) ?? null : null)),
  });
  return [
    pick('price', (p) => p.price),
    pick('price_per_sqft', (p) => p.price_per_sqft),
    pick('beds', (p) => p.beds),
    pick('baths', (p) => p.baths),
    pick('sqft', (p) => p.sqft),
    pick('year_built', (p) => p.year_built),
    pick('status', (p) => p.status),
    pick('cumulative_days_on_market', (p) => p.cumulative_days_on_market),
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
        "Fetch and compare 2 or more Redfin properties side-by-side. Provide an array of targets, each either a `url` or a `property_id`+`listing_id` pair. Returns a compact summary table aligned by field (price, beds/baths, sqft, year built, etc.) plus the full per-property record. Errors for individual properties are captured per-row. Calls are concurrent.",
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
          .max(8)
          .describe('Array of 2–8 properties to compare'),
      },
    },
    async ({ targets }) => {
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
              const env = await client.fetchStingrayJson<AboveTheFoldPayload>(
                `/stingray/api/home/details/aboveTheFold?${params.toString()}`
              );
              const atf = env.payload ?? null;
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
                property: format(initial, atf, canonicalUrl),
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
        summary: buildSummary(results),
        results,
      });
    }
  );
}
