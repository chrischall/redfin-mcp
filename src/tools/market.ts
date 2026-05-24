import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { resolveRegion } from '../autocomplete.js';

/**
 * Redfin market analytics: `GET /stingray/api/region/<region_type>/<region_id>/<property_type>/market-trends`.
 *
 * The endpoint returns a `tableData` object grouped into `homesForSale`
 * and `homesSold`, where each member is a labeled metric like
 * "Median list price" or "# Homes Sold". Each row carries:
 *   - currentHouseAndCondoValue: the raw number (scale depends on
 *     valueType — CURRENCY_THOUSANDS values are in thousands)
 *   - houseAndCondoYoy{Up,ValueProportionalChange}: year-over-year
 *     direction + magnitude (0..1 fraction)
 *   - houseAndCondoMom{Up,ValueProportionalChange}: month-over-month
 *     direction + magnitude
 *   - valueType: LONG | CURRENCY | CURRENCY_THOUSANDS | PERCENT
 *
 * `offer-insights` is a separate sibling endpoint that returns much
 * thinner data (often empty for big cities); we don't use it.
 *
 * `property_type` segment values (from Redfin's URL routing):
 *   1 = all home types (default)
 *   2 = single family
 *   3 = condo
 *   4 = townhouse
 *   5 = multi-family
 *   6 = land
 *
 * Verified live 2026-05-23 against region 2/16163 (Seattle, type=2=city).
 * Note: neighborhood-typed regions (type=6) usually return empty.
 */

type ValueType = 'LONG' | 'CURRENCY' | 'CURRENCY_THOUSANDS' | 'PERCENT';

interface MarketTrendRow {
  label?: string;
  valueType?: ValueType;
  currentHouseAndCondoValue?: number;
  houseAndCondoYoyUp?: boolean;
  houseAndCondoYoyValueProportionalChange?: number;
  houseAndCondoMomUp?: boolean;
  houseAndCondoMomValueProportionalChange?: number;
  isSubItem?: boolean;
  showPrevValues?: boolean;
}

interface MarketTrendsTable {
  homesForSale?: MarketTrendRow[];
  homesSold?: MarketTrendRow[];
  homesForSaleCurMonth?: string;
  homesSoldCurMonth?: string;
}

interface MarketTrendsPayload {
  tableData?: MarketTrendsTable;
  graphData?: Record<string, unknown>;
}

export interface FormattedMetric {
  label?: string;
  value?: number;
  /** Either 'count', 'usd', 'usd_thousands', or 'percent_fraction'. */
  unit?: string;
  yoy_change_fraction?: number;
  yoy_direction?: 'up' | 'down';
  mom_change_fraction?: number;
  mom_direction?: 'up' | 'down';
  is_sub_item?: boolean;
}

const VALUE_TYPE_UNIT: Record<ValueType, FormattedMetric['unit']> = {
  LONG: 'count',
  CURRENCY: 'usd',
  CURRENCY_THOUSANDS: 'usd_thousands',
  PERCENT: 'percent_fraction',
};

export function formatMetric(row: MarketTrendRow): FormattedMetric {
  const out: FormattedMetric = {
    label: row.label,
    value: row.currentHouseAndCondoValue,
    unit: row.valueType ? VALUE_TYPE_UNIT[row.valueType] : undefined,
  };
  if (typeof row.houseAndCondoYoyValueProportionalChange === 'number') {
    out.yoy_change_fraction = row.houseAndCondoYoyValueProportionalChange;
    out.yoy_direction = row.houseAndCondoYoyUp ? 'up' : 'down';
  }
  if (typeof row.houseAndCondoMomValueProportionalChange === 'number') {
    out.mom_change_fraction = row.houseAndCondoMomValueProportionalChange;
    out.mom_direction = row.houseAndCondoMomUp ? 'up' : 'down';
  }
  if (row.isSubItem) out.is_sub_item = true;
  return out;
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
        "Market report for a Redfin region: median list/sold prices, $/sqft, sale-to-list ratio, total homes for sale + sold, all with year-over-year and month-over-month change. Provide either (a) `location` — free-text we resolve via autocomplete (best with city names; \"New York\", \"Seattle\"; neighborhoods typically return empty data), or (b) `region_id` + `region_type` directly. `property_type` defaults to 1 (all). Each metric returns `{ label, value, unit, yoy_change_fraction, yoy_direction, mom_change_fraction, mom_direction }`. Read-only; safe to call repeatedly.",
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
          .describe('Redfin region id (e.g. 30749 for New York City)'),
        region_type: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Redfin region type code (2 = city, 5 = zip code, 6 = neighborhood)'),
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
      const path = `/stingray/api/region/${regionInfo.region_type}/${regionInfo.region_id}/${pt}/market-trends`;
      const env = await client.fetchStingrayJson<MarketTrendsPayload>(path);
      const table = env.payload?.tableData ?? {};
      const homesForSale = (table.homesForSale ?? []).map(formatMetric);
      const homesSold = (table.homesSold ?? []).map(formatMetric);
      return textResult({
        region: regionInfo,
        property_type: pt,
        for_sale_period: table.homesForSaleCurMonth,
        sold_period: table.homesSoldCurMonth,
        homes_for_sale: homesForSale,
        homes_sold: homesSold,
      });
    }
  );
}
