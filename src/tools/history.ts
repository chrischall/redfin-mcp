import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  buildCanonicalUrl,
  resolveIds,
  type AboveTheFoldPayload,
} from './properties.js';

/**
 * Redfin's price + tax history lives in the `belowTheFold` endpoint,
 * under `propertyHistoryInfo.events[]` and `publicRecordsInfo.allTaxInfo[]`.
 *
 * Field-shape gotchas (verified live 2026-05-23 against
 * /WA/Seattle/9243-35th-Ave-SW-98126/unit-C/home/18659204):
 *
 *   - `event.price` is a plain number, not `{amount}` — the Apollo
 *     cache wrapper used elsewhere isn't applied here.
 *   - The tax-history array is `allTaxInfo`, not `taxHistory`. The
 *     `taxInfo` (no `all-`) field is just the current-year roll.
 *   - Tax records use `taxesDue`, not `taxesPaid` — Redfin shows it
 *     as taxes assessed against the property, billed but not necessarily
 *     paid.
 */

interface PropertyHistoryEvent {
  eventDescription?: string;
  source?: string;
  sourceId?: string;
  dataSourceId?: number;
  eventDate?: number; // unix ms
  daysOnMarket?: number;
  price?: number;
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
  taxesDue?: number;
  taxableLandValue?: number;
  taxableImprovementValue?: number;
}

interface PublicRecordsInfo {
  taxInfo?: { taxesDue?: number; rollYear?: number };
  allTaxInfo?: PublicRecordsTaxEvent[];
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

/**
 * Shared normalized event type — same enum used across sibling MCPs
 * (zillow, compass, onehome, homes-com) so downstream code doesn't
 * need per-MCP adapters. See issue #48.
 */
export type NormalizedEventType =
  | 'Listed'
  | 'PriceChange'
  | 'Pending'
  | 'Contingent'
  | 'Sold'
  | 'Withdrawn'
  | 'Relisted'
  | 'Delisted'
  | 'Unknown';

export interface NormalizedEvent {
  date?: string;
  type: NormalizedEventType;
  /** Original Redfin event description, preserved for callers that
   * need the verbatim label. */
  raw_event?: string;
  price?: number;
  /** Percent change from the previous priced event in the series.
   * Computed by `normalizeEvents`, not by the per-event mapper. */
  price_change_pct?: number;
  dom?: number;
  source_mls?: string;
}

/**
 * Map Redfin's free-text `eventDescription` to the shared enum. Order
 * matters — "Listed" matches BOTH "Listed" and "Relisted", so the
 * Relisted check must come first. Same for "Sold (MLS)" / "Sold
 * (Public Records)" → "Sold".
 *
 * The mapping is intentionally generous: any input we can't classify
 * returns `"Unknown"`, and the original string remains in
 * `raw_event` for callers who want it.
 */
export function mapEventType(description: string | undefined): NormalizedEventType {
  if (!description) return 'Unknown';
  const d = description.toLowerCase();
  if (/relist/.test(d)) return 'Relisted';
  if (/withdraw/.test(d)) return 'Withdrawn';
  if (/delist/.test(d)) return 'Delisted';
  if (/sold/.test(d)) return 'Sold';
  if (/pending/.test(d)) return 'Pending';
  if (/contingent/.test(d)) return 'Contingent';
  if (/price (?:change|reduction|increase|reduced)/.test(d)) return 'PriceChange';
  if (/listed/.test(d)) return 'Listed';
  return 'Unknown';
}

/**
 * Build the events_normalized view from raw price-history events:
 * - Map each event's `eventDescription` to the shared enum.
 * - Compute `price_change_pct` against the previous PRICED event in
 *   the series (events without a price don't contribute).
 * - Carry `raw_event`, `dom`, `price`, and the source MLS.
 *
 * Events are sorted oldest-first inside the function so the
 * percent-change math works against the previous event in time order;
 * the caller can re-sort the returned array if it prefers
 * newest-first.
 */
export function normalizeEvents(
  raw: PropertyHistoryEvent[]
): NormalizedEvent[] {
  const sorted = [...raw].sort(
    (a, b) => (a.eventDate ?? 0) - (b.eventDate ?? 0)
  );
  let lastPrice: number | null = null;
  const out: NormalizedEvent[] = [];
  for (const e of sorted) {
    const event: NormalizedEvent = {
      date:
        typeof e.eventDate === 'number'
          ? new Date(e.eventDate).toISOString().slice(0, 10)
          : undefined,
      type: mapEventType(e.eventDescription),
      raw_event: e.eventDescription,
      price: typeof e.price === 'number' ? e.price : undefined,
      dom: e.daysOnMarket,
      source_mls: e.source,
    };
    if (typeof e.price === 'number') {
      if (lastPrice !== null && lastPrice !== 0) {
        event.price_change_pct =
          Math.round(((e.price - lastPrice) / lastPrice) * 1000) / 10;
      }
      lastPrice = e.price;
    }
    out.push(event);
  }
  return out;
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
    price: typeof raw.price === 'number' ? raw.price : undefined,
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
    taxes_paid: raw.taxesDue,
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
  // BTF doesn't carry address data, so when the caller passed IDs only
  // (no URL), fetch ATF in parallel just for addressSectionInfo so we
  // can upgrade the canonical URL away from the /home/<id> short form.
  const btfPromise = client.fetchStingrayJson<BelowTheFoldPayload>(
    `/stingray/api/home/details/belowTheFold?${params.toString()}`
  );
  const atfPromise: Promise<AboveTheFoldPayload | null> = args.url
    ? Promise.resolve(null)
    : client
        .fetchStingrayJson<AboveTheFoldPayload>(
          `/stingray/api/home/details/aboveTheFold?${params.toString()}`
        )
        .then((e) => e.payload ?? null)
        .catch(() => null);
  const [btfEnv, atf] = await Promise.all([btfPromise, atfPromise]);
  const canonicalUrl = args.url
    ? ids.canonicalUrl
    : (buildCanonicalUrl(atf?.addressSectionInfo, ids.propertyId) ?? ids.canonicalUrl);
  return { payload: btfEnv.payload ?? null, canonicalUrl };
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
      const rawEvents = payload?.propertyHistoryInfo?.events ?? [];
      const priceEvents = rawEvents.map(formatPriceEvent);
      // Normalized view — same enum across sibling MCPs (#48). Reversed
      // to newest-first so it tandem-indexes with `price_events`.
      const eventsNormalized = normalizeEvents(rawEvents).reverse();
      const taxEvents = (payload?.publicRecordsInfo?.allTaxInfo ?? []).map(
        formatTaxEvent
      );
      return textResult({
        url: canonicalUrl,
        price_events: priceEvents,
        events_normalized: eventsNormalized,
        tax_events: taxEvents,
      });
    }
  );
}
