import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { urlToPath } from '../url.js';
import {
  extractFeatures,
  loadCommunities,
  type ExtractedFeatures,
} from '../features.js';
import {
  buildPortalUrlHyperlink,
  cleanTaxAnnual,
  collectAddressAlternates,
  hoaToMonthlyUsd,
  lastSold,
  priceDrop,
} from '../derived.js';
import {
  formatPriceEvent,
  formatTaxEvent,
  normalizeEvents,
  type FormattedPriceEvent,
  type FormattedTaxEvent,
  type NormalizedEvent,
} from './history.js';

/**
 * Redfin property details are spread across two endpoints:
 *
 *   1. `GET /stingray/api/home/details/initialInfo?path=<URL>` resolves
 *      a homedetails URL (e.g. /NY/Brooklyn/42-Monroe-St-11238/home/40732555)
 *      to `{ propertyId, listingId, marketId, ... }` — the canonical
 *      handles the rest of the API needs.
 *
 *   2. `GET /stingray/api/home/details/aboveTheFold?propertyId=X&listingId=Y&accessLevel=1`
 *      returns the "above the fold" property data: addressSectionInfo
 *      (street/beds/baths/price/etc.), mediaBrowserInfo (photos),
 *      additionalBrokerageInfo.
 *
 * For tool input, the user can provide:
 *   - `url`: full Redfin URL or path → we hit initialInfo first
 *   - `property_id` + `listing_id`: skip initialInfo (faster, one round-trip)
 *
 * Both verified live 2026-05-23.
 */

export interface InitialInfoPayload {
  propertyId?: number;
  listingId?: number;
  marketId?: number;
  mlsId?: { value?: string } | string;
  latLong?: { value?: { latitude?: number; longitude?: number } };
  marketName?: string;
}

export interface ResolvedIds {
  propertyId: number;
  listingId: number;
  canonicalUrl: string;
  /** initialInfo payload when the URL path was the entry — otherwise null. */
  initial: InitialInfoPayload | null;
}

export class InvalidPropertyUrlError extends Error {
  constructor(url: string, reason: string) {
    super(
      `Redfin property URL "${url}" ${reason}. ` +
        `Redfin homedetails URLs include a "/home/<propertyId>" segment ` +
        `(e.g. "/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345"). ` +
        `Pass property_id + listing_id directly if you already have them, or ` +
        `look up the URL on redfin.com — clicking through to the property page ` +
        `will produce a URL with the correct /home/<id> suffix.`
    );
    this.name = 'InvalidPropertyUrlError';
  }
}

/**
 * Extract the `/home/<propertyId>` propertyId from a Redfin URL.
 * Redfin's canonical homedetails URLs are
 *   /<STATE>/<City>/<StreetAddress>-<ZIP>/home/<propertyId>
 * Returns the propertyId as a string when present, null otherwise.
 */
export function extractPropertyIdFromUrl(url: string): string | null {
  const m = /\/home\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? m[1] : null;
}

/**
 * Resolve property_id + listing_id from either form of caller input.
 * Shared by `redfin_get_property` and the v0.3 tools (compare,
 * price-history, climate-risk, comparable-rentals).
 *
 * Throws `InvalidPropertyUrlError` for URLs missing the `/home/<id>`
 * segment — `initialInfo` returns an empty payload for those, so the
 * downstream "did not return propertyId+listingId" error was unhelpful.
 */
export async function resolveIds(
  client: RedfinClient,
  args: { url?: string; property_id?: number; listing_id?: number }
): Promise<ResolvedIds> {
  if (args.property_id && args.listing_id) {
    return {
      propertyId: args.property_id,
      listingId: args.listing_id,
      canonicalUrl: args.url
        ? args.url.startsWith('http')
          ? args.url
          : `https://www.redfin.com${urlToPath(args.url)}`
        : `https://www.redfin.com/home/${args.property_id}`,
      initial: null,
    };
  }
  if (!args.url) {
    throw new Error('provide either url, or both property_id + listing_id');
  }
  if (extractPropertyIdFromUrl(args.url) === null) {
    throw new InvalidPropertyUrlError(
      args.url,
      "doesn't contain the required `/home/<propertyId>` segment"
    );
  }
  const path = urlToPath(args.url);
  const env = await client.fetchStingrayJson<InitialInfoPayload>(
    `/stingray/api/home/details/initialInfo?path=${encodeURIComponent(path)}`
  );
  const initial = env.payload ?? null;
  if (!initial?.propertyId || !initial?.listingId) {
    throw new Error(
      `Redfin's initialInfo endpoint returned no propertyId+listingId for "${args.url}". ` +
        `The URL has the right shape (/home/<id> is present) but Redfin couldn't resolve it — ` +
        `the listing may have been delisted, the slug may have changed, or the propertyId may be invalid. ` +
        `Re-grab the URL from redfin.com and retry.`
    );
  }
  return {
    propertyId: initial.propertyId,
    listingId: initial.listingId,
    canonicalUrl: args.url.startsWith('http')
      ? args.url
      : `https://www.redfin.com${path}`,
    initial,
  };
}

export interface AddressSectionInfo {
  streetAddress?: { assembledAddress?: string } | string;
  city?: string;
  state?: string;
  zip?: string;
  beds?: number;
  baths?: number;
  yearBuilt?: { value?: number } | number;
  sqFt?: { value?: number } | number;
  pricePerSqFt?: { value?: number } | number;
  priceInfo?: { amount?: number; label?: string };
  latestPriceInfo?: { amount?: number; label?: string };
  previousPriceInfo?: { amount?: number; label?: string };
  status?: { displayValue?: string };
  cumulativeDaysOnMarket?: number;
  daysOnMarketLabel?: string;
  soldDate?: number;
  fips?: string;
  apn?: string;
  latLong?: { value?: { latitude?: number; longitude?: number } };
}

// Redfin's canonical homedetails URL is /<STATE>/<City>/<Street>-<ZIP>/home/<id>.
// Returns null when address parts are missing so the caller can fall back.
export function buildCanonicalUrl(
  addr: AddressSectionInfo | undefined,
  propertyId: number | undefined
): string | null {
  if (!addr || !propertyId) return null;
  const street =
    typeof addr.streetAddress === 'object'
      ? addr.streetAddress?.assembledAddress
      : addr.streetAddress;
  if (!street || !addr.city || !addr.state || !addr.zip) return null;
  const slug = (s: string) => s.trim().replace(/\s+/g, '-');
  return `https://www.redfin.com/${addr.state}/${slug(addr.city)}/${slug(street)}-${addr.zip}/home/${propertyId}`;
}

interface MediaBrowserInfo {
  photos?: Array<{
    photoUrls?: { fullScreenPhotoUrl?: string };
  }>;
}

/**
 * Redfin surfaces the listing's public-remarks marketing prose as
 * `mainHouseInfo.publicRemarksParagraph` inside the aboveTheFold
 * payload — the field is typically 500–3000 chars of agent-authored
 * copy. Verified live against /NC/Lake-Lure/268-Mallard-Rd-28746/...
 * 2026-05-27. Callers usually want the keyword-extracted features (see
 * `extracted_features`) rather than the raw text, so `description` is
 * opt-in via `include_description: true`.
 *
 * Other mainHouseInfo bits we lift derived fields off:
 *   - `hoaDues.{amount, frequency}`: feeds `hoa_monthly_usd` (#34).
 *   - `unparsedAddress` / `secondaryAddress`: candidates for
 *     `address_alternates` (#42).
 */
interface HoaDues {
  amount?: number;
  frequency?: string;
}

interface MainHouseInfo {
  publicRemarksParagraph?: string;
  hoaDues?: HoaDues;
  /** MLS-feed-supplied flat address. May disagree with the primary
   * built address (see #42). */
  unparsedAddress?: string;
  /** Some Redfin records carry a secondary MLS address (#42). */
  secondaryAddress?: string;
}

export interface AboveTheFoldPayload {
  addressSectionInfo?: AddressSectionInfo;
  mediaBrowserInfo?: MediaBrowserInfo;
  mainHouseInfo?: MainHouseInfo;
}

function unwrap<T>(x: T | { value?: T } | undefined): T | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'object' && 'value' in (x as object)) {
    return (x as { value?: T }).value;
  }
  return x as T;
}

export interface FormattedProperty {
  property_id?: number;
  listing_id?: number;
  market_id?: number;
  mls_id?: string;
  url: string;
  /** Sheets-paste-ready hyperlink formula pointing at the same listing.
   * Always present (mirrors `url`). Pasting it into Google Sheets
   * renders as a clickable "Redfin" link. See issue #41. */
  portal_url_hyperlink: string;
  market_name?: string;
  address?: string;
  /** Alternate addresses from other MLS feeds, prior listings, or
   * parcel variants. Excludes the primary (kept in `address`). Omitted
   * when empty/absent. See issue #42. */
  address_alternates?: string[];
  city?: string;
  state?: string;
  zip?: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  price_per_sqft?: number;
  year_built?: number;
  price?: number;
  price_label?: string;
  /** Previous list price when Redfin exposes one — feeds price-drop
   * derived fields. */
  previous_list_price?: number;
  /** `previous_list_price - price`. `null` when either is missing. (#35) */
  price_drop_amount?: number | null;
  /** `(previous - current) / previous * 100`, rounded to 0.1. (#35) */
  price_drop_percent?: number | null;
  status?: string;
  cumulative_days_on_market?: number;
  days_on_market_label?: string;
  sold_date_unix_ms?: number;
  /** ISO date of the most recent Sold event (from price-history). (#50)
   * Surfaced inline; no extra fetch needed because the caller often has
   * the history loaded already (or, when only ATF is fetched, this
   * stays `null`). */
  last_sold_date?: string | null;
  /** Sale price of the most recent Sold event. (#50) */
  last_sold_price?: number | null;
  /** Monthly-normalized HOA cost derived from hoaDues.{amount, frequency}.
   * `null` when the frequency is unknown or no fee is reported. (#34) */
  hoa_monthly_usd?: number | null;
  /** `null` when the upstream raw value is the 0/1 not-yet-assessed
   * placeholder. See `tax_status` for the discriminator. (#36) */
  tax_annual?: number | null;
  /** `"not_yet_assessed"` when `tax_annual` was the 0/1 placeholder,
   * else `null`. Future-proofed for `"estimated"` / `"actual"` once
   * upstream surfaces a marker. (#36) */
  tax_status?: 'not_yet_assessed' | null;
  latitude?: number;
  longitude?: number;
  fips?: string;
  apn?: string;
  primary_photo_url?: string;
  /** Raw public-remarks marketing prose. Only emitted when caller
   * passes `include_description: true` — see issue #32. */
  description?: string;
  /** Server-side keyword extraction from `description`. Always emitted
   * when the listing has any prose; lifts work callers were doing
   * client-side. See `src/features.ts` + issue #33. */
  extracted_features?: ExtractedFeatures;
}

export interface FormatOptions {
  /** Default false — see issue #32. Per-record marketing copy is
   * 1.5–3 KB of context noise. */
  includeDescription?: boolean;
  /** Optional price-history events; when present, the formatter
   * derives `last_sold_date` + `last_sold_price` (#50) from them.
   * Pass the raw `propertyHistoryInfo.events` from belowTheFold. */
  events?: Array<{ eventDescription?: string; eventDate?: number; price?: number }>;
  /** Optional current-year tax dollars (from `publicRecordsInfo.taxInfo.taxesDue`).
   * When supplied, the formatter null-cleans the 0/1 sentinel and emits
   * `tax_status: "not_yet_assessed"` for that case (#36). */
  taxAnnual?: number | null;
}

export function format(
  initial: InitialInfoPayload | null,
  atf: AboveTheFoldPayload | null,
  url: string,
  opts: FormatOptions = {}
): FormattedProperty {
  const addr = atf?.addressSectionInfo ?? {};
  const street =
    typeof addr.streetAddress === 'object'
      ? addr.streetAddress?.assembledAddress
      : addr.streetAddress;
  const price = addr.latestPriceInfo?.amount ?? addr.priceInfo?.amount;
  const previousPrice = addr.previousPriceInfo?.amount;
  const photo = atf?.mediaBrowserInfo?.photos?.[0]?.photoUrls?.fullScreenPhotoUrl;
  const mls =
    typeof initial?.mlsId === 'object' ? initial.mlsId?.value : initial?.mlsId;
  const mainHouse = atf?.mainHouseInfo;
  const remarks = mainHouse?.publicRemarksParagraph;
  const features =
    typeof remarks === 'string' && remarks.length > 0
      ? extractFeatures(remarks, loadCommunities())
      : undefined;
  const address =
    [street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ') ||
    undefined;
  const alternates = collectAddressAlternates(address, [
    mainHouse?.unparsedAddress,
    mainHouse?.secondaryAddress,
  ]);
  const drop = priceDrop(price, previousPrice);
  const hoa = hoaToMonthlyUsd(mainHouse?.hoaDues?.amount, mainHouse?.hoaDues?.frequency);
  const sold = opts.events ? lastSold(opts.events) : { last_sold_date: null, last_sold_price: null };
  const taxCleaned =
    opts.taxAnnual !== undefined
      ? cleanTaxAnnual(opts.taxAnnual)
      : { tax_annual: null as number | null, tax_status: null as 'not_yet_assessed' | null };
  return {
    property_id: initial?.propertyId,
    listing_id: initial?.listingId,
    market_id: initial?.marketId,
    mls_id: mls,
    market_name: initial?.marketName,
    url,
    portal_url_hyperlink: buildPortalUrlHyperlink(url),
    address,
    ...(alternates.length > 0 ? { address_alternates: alternates } : {}),
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    beds: addr.beds,
    baths: addr.baths,
    sqft: unwrap(addr.sqFt),
    price_per_sqft: unwrap(addr.pricePerSqFt),
    year_built: unwrap(addr.yearBuilt),
    price,
    price_label: addr.latestPriceInfo?.label ?? addr.priceInfo?.label,
    ...(typeof previousPrice === 'number' ? { previous_list_price: previousPrice } : {}),
    price_drop_amount: drop.price_drop_amount,
    price_drop_percent: drop.price_drop_percent,
    status: addr.status?.displayValue,
    cumulative_days_on_market: addr.cumulativeDaysOnMarket,
    days_on_market_label: addr.daysOnMarketLabel,
    sold_date_unix_ms: addr.soldDate,
    last_sold_date: sold.last_sold_date,
    last_sold_price: sold.last_sold_price,
    hoa_monthly_usd: hoa,
    tax_annual: taxCleaned.tax_annual,
    tax_status: taxCleaned.tax_status,
    latitude:
      addr.latLong?.value?.latitude ?? initial?.latLong?.value?.latitude,
    longitude:
      addr.latLong?.value?.longitude ?? initial?.latLong?.value?.longitude,
    fips: addr.fips,
    apn: addr.apn,
    primary_photo_url: photo,
    ...(opts.includeDescription && remarks ? { description: remarks } : {}),
    ...(features ? { extracted_features: features } : {}),
  };
}

export function registerPropertyTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_property',
    {
      title: 'Get Redfin property details',
      description:
        "Fetch a property's full Redfin record. Provide either (a) `url` — full Redfin homedetails URL or path, which we'll resolve via the initialInfo endpoint, or (b) `property_id` + `listing_id` — skip the resolution and go straight to aboveTheFold. Returns address, beds/baths, sqft, year built, price, status, days on market, the primary photo URL, plus derived fields (price_drop_*, hoa_monthly_usd, last_sold_*, tax_annual, extracted_features). The raw marketing description is OMITTED by default — opt in with `include_description: true`. Set `include_price_history: true` to bundle the full price history (and the cross-MCP-normalized `events_normalized` view) inline; set `include_tax_history: true` for `tax_history`. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Redfin property details',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            'Redfin homedetails URL or path (e.g. /NY/Brooklyn/42-Monroe-St-11238/home/40732555)'
          ),
        property_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Numeric Redfin property ID. Pair with listing_id to skip the URL resolve step.'
          ),
        listing_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Numeric Redfin listing ID. Required when property_id is provided.'
          ),
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include the raw marketing/public-remarks description string in the response. Default false to save context — `extracted_features` always carries the structured signal callers actually need.'
          ),
        include_price_history: z
          .boolean()
          .optional()
          .describe(
            'Bundle the full price history inline as `price_history` + `events_normalized`. Default false. Saves a follow-up redfin_get_price_history round trip — use this when a workflow needs both. (#49)'
          ),
        include_tax_history: z
          .boolean()
          .optional()
          .describe(
            'Bundle the full tax history inline as `tax_history`. Default false. (#49)'
          ),
      },
    },
    async ({ url, property_id, listing_id, include_description, include_price_history, include_tax_history }) => {
      // Route through resolveIds so URL-shape validation (Bug 4 fix)
      // and the InvalidPropertyUrlError path fire for this entry point
      // too — not just for compare/history/climate/rentals.
      const ids = await resolveIds(client, { url, property_id, listing_id });
      const { propertyId, listingId } = ids;
      let initial: InitialInfoPayload | null = ids.initial;

      const atfParams = new URLSearchParams({
        propertyId: String(propertyId),
        accessLevel: '1',
        listingId: String(listingId),
      });
      // Fetch ATF + BTF in parallel so we can surface the cheap derived
      // fields (#50 last_sold_*, #36 tax_annual placeholder cleanup)
      // without forcing the caller to make a second tool call.
      const [atfEnv, btf] = await Promise.all([
        client.fetchStingrayJson<AboveTheFoldPayload>(
          `/stingray/api/home/details/aboveTheFold?${atfParams.toString()}`
        ),
        client.fetchStingrayJson<{
          propertyHistoryInfo?: {
            events?: Array<{
              eventDescription?: string;
              eventDate?: number;
              price?: number;
              daysOnMarket?: number;
              source?: string;
              sourceId?: string;
            }>;
          };
          publicRecordsInfo?: {
            taxInfo?: { taxesDue?: number };
            allTaxInfo?: Array<{
              rollYear?: number;
              taxesDue?: number;
              taxableLandValue?: number;
              taxableImprovementValue?: number;
            }>;
          };
        }>(`/stingray/api/home/details/belowTheFold?${atfParams.toString()}`)
          .then((e) => (e ? e.payload ?? null : null))
          .catch(() => null),
      ]);
      const atf = atfEnv.payload ?? null;

      // resolveIds emits the short /home/<id> form when the caller passed
      // IDs without a URL; upgrade to the canonical full path once ATF
      // gives us the address parts.
      const canonicalUrl =
        url ? ids.canonicalUrl : (buildCanonicalUrl(atf?.addressSectionInfo, propertyId) ?? ids.canonicalUrl);

      if (!initial) initial = { propertyId, listingId };
      const formatted = format(initial, atf, canonicalUrl, {
        includeDescription: include_description === true,
        events: btf?.propertyHistoryInfo?.events,
        taxAnnual: btf?.publicRecordsInfo?.taxInfo?.taxesDue,
      });

      // #49 bundling. BTF is already fetched above for the cheap
      // derived fields — when the caller opts in, surface the full
      // histories inline so they don't have to make a follow-up call.
      let price_history: FormattedPriceEvent[] | undefined;
      let events_normalized: NormalizedEvent[] | undefined;
      let tax_history: FormattedTaxEvent[] | undefined;
      if (include_price_history === true && btf?.propertyHistoryInfo?.events) {
        price_history = btf.propertyHistoryInfo.events.map(formatPriceEvent);
        // Reverse to newest-first so it tandem-indexes with `price_history`.
        events_normalized = normalizeEvents(btf.propertyHistoryInfo.events).reverse();
      }
      if (include_tax_history === true && btf?.publicRecordsInfo?.allTaxInfo) {
        tax_history = btf.publicRecordsInfo.allTaxInfo.map(formatTaxEvent);
      }

      return textResult({
        ...formatted,
        ...(price_history ? { price_history } : {}),
        ...(events_normalized ? { events_normalized } : {}),
        ...(tax_history ? { tax_history } : {}),
      });
    }
  );
}
