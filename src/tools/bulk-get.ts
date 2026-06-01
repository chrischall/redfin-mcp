import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  mapWithConcurrency,
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

interface BulkTarget {
  url?: string;
  property_id?: number;
  listing_id?: number;
}

/**
 * Per-row outcome status. `'ok'` for a fetched property; otherwise the
 * `classifyRowError` kind so the cohort's "20-of-20 with X timeouts"
 * summary reporting can branch without re-parsing the message string.
 */
type BulkRowStatus = 'ok' | 'timeout' | 'bridge_down' | 'protocol' | 'other';

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
 * same row won't change the outcome.
 */
const RETRYABLE_ROW_KINDS = new Set(['timeout', 'bridge_down']);

async function fetchOne(
  client: RedfinClient,
  t: BulkTarget,
  includeDescription: boolean
): Promise<BulkPerProperty> {
  try {
    // Shared resolveIds → parallel ATF/BTF → format pipeline (same one
    // get_property + compare_properties use).
    const { ids, canonicalUrl, property } = await fetchAndFormatProperty(
      client,
      t,
      { includeDescription }
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
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_bulk_get',
    {
      title: 'Bulk fetch Redfin property records',
      description:
        "Fetch up to 200 Redfin property records in a single tool call. Provide an array of targets, each one of: a `url` (full Redfin homedetails URL or path with the /home/<id> segment), a `property_id` alone (resolved internally by following Redfin's /home/<id> redirect to the canonical listing), or a `property_id`+`listing_id` pair (fastest — skips resolution). Returns the same per-property record shape as `redfin_get_property`, but without a summary table — use `redfin_compare_properties` for that. Per-target errors are captured per-row; a single bad ID does not fail the batch. Server-side concurrency, ~6 in flight at a time. Use this when you have a list of saved homes / candidate properties and need the full structured data for every one of them.",
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
      const results = await mapWithConcurrency(
        targets as BulkTarget[],
        BRIDGE_CONCURRENCY,
        (t) => fetchOne(client, t, include_description === true)
      );
      const ok = results.filter((r) => r.status === 'ok').length;
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
