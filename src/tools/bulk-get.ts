import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  mapWithConcurrency,
} from '@fetchproxy/server';
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
 * `redfin_bulk_get`: unbounded structured fetch for many properties in
 * a single tool call. Designed for "I have 50 saved homes, give me
 * everything" workflows that today require sequential
 * `redfin_compare_properties` rounds (8-property cap each).
 *
 * Each target can be a URL or a property_id+listing_id pair. Per-target
 * errors are captured per-row so a single bad ID doesn't fail the
 * batch. ATF + BTF are fetched in parallel per target (same pipeline
 * as get_property), and targets themselves are fanned out concurrently
 * via `mapWithConcurrency` from `@fetchproxy/server` (cap pinned at
 * {@link BRIDGE_CONCURRENCY}=6 — the round-3 cohort comparison value)
 * to avoid hammering Redfin.
 *
 * Hard cap: 200 targets per call. See issue #38.
 */

const MAX_TARGETS = 200;

interface BulkTarget {
  url?: string;
  property_id?: number;
  listing_id?: number;
}

interface BulkPerProperty {
  property_id?: number;
  url: string;
  property?: FormattedProperty;
  error?: string;
}

async function fetchOne(
  client: RedfinClient,
  t: BulkTarget,
  includeDescription: boolean
): Promise<BulkPerProperty> {
  try {
    const ids = await resolveIds(client, t);
    const params = new URLSearchParams({
      propertyId: String(ids.propertyId),
      accessLevel: '1',
      listingId: String(ids.listingId),
    });
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
        }>(`/stingray/api/home/details/belowTheFold?${params.toString()}`)
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
      : buildCanonicalUrl(atf?.addressSectionInfo, ids.propertyId) ??
        ids.canonicalUrl;
    return {
      property_id: ids.propertyId,
      url: canonicalUrl,
      property: format(initial, atf, canonicalUrl, {
        includeDescription,
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

export function registerBulkGetTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_bulk_get',
    {
      title: 'Bulk fetch Redfin property records',
      description:
        "Fetch up to 200 Redfin property records in a single tool call. Provide an array of targets, each either a `url` or a `property_id`+`listing_id` pair. Returns the same per-property record shape as `redfin_get_property`, but without a summary table — use `redfin_compare_properties` for that. Per-target errors are captured per-row; a single bad ID does not fail the batch. Server-side concurrency, ~6 in flight at a time. Use this when you have a list of saved homes / candidate properties and need the full structured data for every one of them.",
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
                url: z.string().optional(),
                property_id: z.number().int().positive().optional(),
                listing_id: z.number().int().positive().optional(),
              })
              .refine(
                (v) => !!v.url || (!!v.property_id && !!v.listing_id),
                'each target needs url, or property_id+listing_id'
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
      const results = await mapWithConcurrency(
        targets as BulkTarget[],
        BRIDGE_CONCURRENCY,
        (t) => fetchOne(client, t, include_description === true)
      );
      const ok = results.filter((r) => !r.error).length;
      const errored = results.length - ok;
      return textResult({
        count: results.length,
        ok,
        errored,
        results,
      });
    }
  );
}
