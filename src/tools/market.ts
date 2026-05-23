import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { resolveRegion } from '../autocomplete.js';

/**
 * Redfin market analytics: `GET /stingray/api/region/<region_type>/<region_id>/<property_type>/offer-insights`.
 *
 * Returns formatted strings (e.g. "$870K", "+2.4%", "70") for things
 * like medianSalePrice, numHomesSold, avgDaysOnMarket. We pass them
 * through as-is since Redfin's own dashboard does the same.
 *
 * `property_type` segment values (from Redfin's URL routing):
 *   1 = all home types (default)
 *   2 = single family
 *   3 = condo
 *   4 = townhouse
 *   5 = multi-family
 *   6 = land
 *
 * Verified live 2026-05-23 against region 6/30749 (New York City).
 */

interface OfferInsightsPayload {
  medianListPrice?: string;
  medianListPerSqFt?: string;
  medianSalePrice?: string;
  medianSalePerSqFt?: string;
  medianSalePerList?: string;
  avgNumOffers?: string;
  avgDownPayment?: string;
  numHomesSold?: string;
  numHomesOnMarket?: string;
  avgDaysOnMarket?: string;
  yoySalePrice?: string;
  yoySalePerSqft?: string;
  /** Catch-all so we surface any fields we haven't typed yet. */
  [key: string]: string | undefined;
}

export function registerMarketTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_market_report',
    {
      title: 'Get Redfin market report for a region',
      description:
        "Market report for a Redfin region: median sale/list prices, price per sqft, average days on market, year-over-year change, number of homes sold and on market. Provide either (a) `location` — free-text we resolve via autocomplete (e.g. 'Brooklyn, NY'), or (b) `region_id` + `region_type` directly. `property_type` defaults to 1 (all home types). All returned metrics are pre-formatted strings (e.g. '$870K', '+2.4%'). Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Redfin market report for a region',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        location: z
          .string()
          .optional()
          .describe('Free-text location to autocomplete (alternative to region_id+region_type)'),
        region_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Redfin region id (e.g. 30749 for NYC)'),
        region_type: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Redfin region type code (6 = city, etc.)'),
        property_type: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Property type filter, default 1 (all)'),
      },
    },
    async ({ location, region_id, region_type, property_type }) => {
      let regionInfo: {
        region_id: number;
        region_type: number;
        name?: string;
        sub_name?: string;
      };
      if (region_id && region_type) {
        regionInfo = { region_id, region_type };
      } else if (location) {
        const r = await resolveRegion(client, location);
        if (!r) {
          throw new Error(
            `redfin_get_market_report: could not resolve location "${location}" to a Redfin region.`
          );
        }
        regionInfo = {
          region_id: r.region_id,
          region_type: r.region_type,
          name: r.name,
          sub_name: r.sub_name,
        };
      } else {
        throw new Error(
          'redfin_get_market_report: provide either location, or both region_id + region_type.'
        );
      }
      const pt = property_type ?? 1;
      const path = `/stingray/api/region/${regionInfo.region_type}/${regionInfo.region_id}/${pt}/offer-insights`;
      const env = await client.fetchStingrayJson<OfferInsightsPayload>(path);
      const metrics = env.payload ?? {};
      return textResult({
        region: regionInfo,
        property_type: pt,
        metrics,
      });
    }
  );
}
