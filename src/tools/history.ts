import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { resolveIds } from './properties.js';

/**
 * Redfin's price + tax history lives in the `belowTheFold` endpoint,
 * under `propertyHistoryInfo.events[]` and `publicRecordsInfo.taxHistory[]`.
 *
 * Verified live 2026-05-23 — `belowTheFold` returns payload keys
 * including amenitiesInfo, publicRecordsInfo, propertyHistoryInfo,
 * buyingPowerInfo.
 */

interface PropertyHistoryEvent {
  eventDescription?: string;
  source?: string;
  sourceId?: string;
  dataSourceId?: number;
  eventDate?: number; // unix ms
  daysOnMarket?: number;
  price?: { amount?: number; level?: number };
  priceDisplayLevel?: number;
  isPriceTransparent?: boolean;
}

interface PropertyHistoryInfo {
  events?: PropertyHistoryEvent[];
  isUnsupported?: boolean;
  historyHasEvents?: boolean;
}

interface PublicRecordsTaxEvent {
  rollYear?: number;
  taxesPaid?: number;
  taxableLandValue?: number;
  taxableImprovementValue?: number;
}

interface PublicRecordsInfo {
  taxInfo?: { taxesDue?: number; rollYear?: number };
  taxHistory?: PublicRecordsTaxEvent[];
  basicInfo?: { yearBuilt?: number; sqFtFinished?: number };
}

interface BelowTheFoldPayload {
  propertyHistoryInfo?: PropertyHistoryInfo;
  publicRecordsInfo?: PublicRecordsInfo;
}

export interface FormattedPriceEvent {
  date?: string;
  event?: string;
  price?: number;
  days_on_market?: number;
  source?: string;
  source_id?: string;
}

export interface FormattedTaxEvent {
  year?: number;
  taxes_paid?: number;
  land_value?: number;
  improvement_value?: number;
  total_assessed_value?: number;
}

export function formatPriceEvent(raw: PropertyHistoryEvent): FormattedPriceEvent {
  return {
    date:
      typeof raw.eventDate === 'number'
        ? new Date(raw.eventDate).toISOString().slice(0, 10)
        : undefined,
    event: raw.eventDescription,
    price: raw.price?.amount,
    days_on_market: raw.daysOnMarket,
    source: raw.source,
    source_id: raw.sourceId,
  };
}

export function formatTaxEvent(raw: PublicRecordsTaxEvent): FormattedTaxEvent {
  const land = raw.taxableLandValue;
  const imp = raw.taxableImprovementValue;
  const total =
    typeof land === 'number' || typeof imp === 'number'
      ? (land ?? 0) + (imp ?? 0)
      : undefined;
  return {
    year: raw.rollYear,
    taxes_paid: raw.taxesPaid,
    land_value: land,
    improvement_value: imp,
    total_assessed_value: total,
  };
}

export async function fetchBelowTheFold(
  client: RedfinClient,
  args: { url?: string; property_id?: number; listing_id?: number }
): Promise<{ payload: BelowTheFoldPayload | null; canonicalUrl: string }> {
  const ids = await resolveIds(client, args);
  const params = new URLSearchParams({
    propertyId: String(ids.propertyId),
    accessLevel: '1',
    listingId: String(ids.listingId),
  });
  const env = await client.fetchStingrayJson<BelowTheFoldPayload>(
    `/stingray/api/home/details/belowTheFold?${params.toString()}`
  );
  return { payload: env.payload ?? null, canonicalUrl: ids.canonicalUrl };
}

export function registerHistoryTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_price_history',
    {
      title: 'Get Redfin price history for a property',
      description:
        "Listing-price events for a property — listings, price changes, pending, sold, etc. Each entry has a date, event description, price, days-on-market at that point, and the data-source attribution (MLS, county records, etc.). Also returns the tax-history series from public records. Provide either `url` or `property_id`+`listing_id`. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Redfin price history for a property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().optional().describe('Redfin homedetails URL or path'),
        property_id: z.number().int().positive().optional(),
        listing_id: z.number().int().positive().optional(),
      },
    },
    async ({ url, property_id, listing_id }) => {
      const { payload, canonicalUrl } = await fetchBelowTheFold(client, {
        url,
        property_id,
        listing_id,
      });
      const priceEvents = (payload?.propertyHistoryInfo?.events ?? []).map(
        formatPriceEvent
      );
      const taxEvents = (payload?.publicRecordsInfo?.taxHistory ?? []).map(
        formatTaxEvent
      );
      return textResult({
        url: canonicalUrl,
        price_events: priceEvents,
        tax_events: taxEvents,
      });
    }
  );
}
