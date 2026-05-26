import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { urlToPath } from '../url.js';

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

export interface AboveTheFoldPayload {
  addressSectionInfo?: AddressSectionInfo;
  mediaBrowserInfo?: MediaBrowserInfo;
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
  market_name?: string;
  address?: string;
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
  status?: string;
  cumulative_days_on_market?: number;
  days_on_market_label?: string;
  sold_date_unix_ms?: number;
  latitude?: number;
  longitude?: number;
  fips?: string;
  apn?: string;
  primary_photo_url?: string;
}

export function format(
  initial: InitialInfoPayload | null,
  atf: AboveTheFoldPayload | null,
  url: string
): FormattedProperty {
  const addr = atf?.addressSectionInfo ?? {};
  const street =
    typeof addr.streetAddress === 'object'
      ? addr.streetAddress?.assembledAddress
      : addr.streetAddress;
  const price = addr.latestPriceInfo?.amount ?? addr.priceInfo?.amount;
  const photo = atf?.mediaBrowserInfo?.photos?.[0]?.photoUrls?.fullScreenPhotoUrl;
  const mls =
    typeof initial?.mlsId === 'object' ? initial.mlsId?.value : initial?.mlsId;
  return {
    property_id: initial?.propertyId,
    listing_id: initial?.listingId,
    market_id: initial?.marketId,
    mls_id: mls,
    market_name: initial?.marketName,
    url,
    address:
      [street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ') ||
      undefined,
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
    status: addr.status?.displayValue,
    cumulative_days_on_market: addr.cumulativeDaysOnMarket,
    days_on_market_label: addr.daysOnMarketLabel,
    sold_date_unix_ms: addr.soldDate,
    latitude:
      addr.latLong?.value?.latitude ?? initial?.latLong?.value?.latitude,
    longitude:
      addr.latLong?.value?.longitude ?? initial?.latLong?.value?.longitude,
    fips: addr.fips,
    apn: addr.apn,
    primary_photo_url: photo,
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
        "Fetch a property's full Redfin record. Provide either (a) `url` — full Redfin homedetails URL or path, which we'll resolve via the initialInfo endpoint, or (b) `property_id` + `listing_id` — skip the resolution and go straight to aboveTheFold. Returns address, beds/baths, sqft, year built, price, status, days on market, and the primary photo URL. Read-only; safe to call repeatedly.",
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
      },
    },
    async ({ url, property_id, listing_id }) => {
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
      const atfEnv = await client.fetchStingrayJson<AboveTheFoldPayload>(
        `/stingray/api/home/details/aboveTheFold?${atfParams.toString()}`
      );
      const atf = atfEnv.payload ?? null;

      // resolveIds emits the short /home/<id> form when the caller passed
      // IDs without a URL; upgrade to the canonical full path once ATF
      // gives us the address parts.
      const canonicalUrl =
        url ? ids.canonicalUrl : (buildCanonicalUrl(atf?.addressSectionInfo, propertyId) ?? ids.canonicalUrl);

      if (!initial) initial = { propertyId, listingId };
      return textResult(format(initial, atf, canonicalUrl));
    }
  );
}
