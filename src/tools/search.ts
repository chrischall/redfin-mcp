import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { resolveRegion } from '../autocomplete.js';

/**
 * Redfin's search API: `GET /stingray/api/gis?...&region_id=X&region_type=Y`
 *
 * Steps:
 *   1. Resolve the user's free-text location to a region (region_id +
 *      region_type) via `location-autocomplete`.
 *   2. Call the gis endpoint with the region + filter params. Filters
 *      ride as query-string ints/CSVs (Redfin's web app does the same).
 *   3. Strip the `{}&&` prefix (RedfinClient.fetchStingrayJson handles
 *      this), then format `payload.homes[]` into a stable shape.
 *
 * Status codes (the `status` query param):
 *   1 = active for sale (the default)
 *   9 = active + coming-soon + contingent + pending (Redfin's default
 *       "everything for sale" view; gives more results than 1 alone)
 *
 * Verified live 2026-05-23 against region 30749 (New York City).
 */

type HomeType =
  | 'house'
  | 'condo'
  | 'townhouse'
  | 'multi_family'
  | 'manufactured'
  | 'land';

/** Redfin's `uipt` (UI Property Type) bitmap values. */
const HOME_TYPE_UIPT: Record<HomeType, number> = {
  house: 1,
  condo: 2,
  townhouse: 3,
  multi_family: 4,
  land: 5,
  manufactured: 6,
};

type StatusKey = 'for_sale' | 'for_rent' | 'sold';

const STATUS_CODES: Record<StatusKey, number> = {
  for_sale: 9,
  for_rent: 9, // Different URL path entirely on Redfin (`/apartments-for-rent/...`); v0.1.0 returns sale results.
  sold: 9, // Same — sold has a separate `/recently-sold` path. v0.1.0 supports for_sale only.
};

export interface RawHome {
  propertyId?: number;
  listingId?: number;
  mlsId?: { value?: string };
  mlsStatus?: string;
  url?: string;
  streetLine?: { value?: string } | string;
  unitNumber?: { value?: string };
  city?: string;
  state?: string;
  zip?: string;
  price?: number | { value?: number };
  beds?: number;
  baths?: number;
  sqFt?: number | { value?: number };
  pricePerSqFt?: number | { value?: number };
  lotSize?: number | { value?: number };
  yearBuilt?: number | { value?: number };
  hoa?: number | { value?: number };
  latLong?: { value?: { latitude?: number; longitude?: number } };
  propertyType?: number;
  uiPropertyType?: number;
  searchStatus?: number;
  timeOnRedfin?: number;
  dom?: { value?: number };
}

export interface FormattedHome {
  property_id: number;
  listing_id?: number;
  mls_id?: string;
  status?: string;
  url: string;
  address: string;
  street?: string;
  unit?: string;
  city?: string;
  state?: string;
  zip?: string;
  price?: number;
  price_per_sqft?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  lot_size?: number;
  year_built?: number;
  hoa_monthly?: number;
  latitude?: number;
  longitude?: number;
  property_type?: number;
  days_on_redfin?: number;
}

/** Unwrap `{value: X}` envelope, or pass through raw values. */
function v<T>(x: T | { value?: T } | undefined): T | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'object' && 'value' in (x as object)) {
    return (x as { value?: T }).value;
  }
  return x as T;
}

export function formatHome(raw: RawHome): FormattedHome | null {
  if (!raw.propertyId) return null;
  const street = v(raw.streetLine);
  const unit = v(raw.unitNumber);
  const fullUrl = raw.url
    ? raw.url.startsWith('http')
      ? raw.url
      : `https://www.redfin.com${raw.url}`
    : `https://www.redfin.com/home/${raw.propertyId}`;
  const address = [
    [street, unit].filter(Boolean).join(' ').trim(),
    raw.city,
    raw.state,
    raw.zip,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    property_id: raw.propertyId,
    listing_id: raw.listingId,
    mls_id: v(raw.mlsId as { value?: string }),
    status: raw.mlsStatus,
    url: fullUrl,
    address,
    street,
    unit,
    city: raw.city,
    state: raw.state,
    zip: raw.zip,
    price: v(raw.price),
    price_per_sqft: v(raw.pricePerSqFt),
    beds: raw.beds,
    baths: raw.baths,
    sqft: v(raw.sqFt),
    lot_size: v(raw.lotSize),
    year_built: v(raw.yearBuilt),
    hoa_monthly: v(raw.hoa),
    latitude: raw.latLong?.value?.latitude,
    longitude: raw.latLong?.value?.longitude,
    property_type: raw.uiPropertyType ?? raw.propertyType,
    days_on_redfin: v(raw.dom),
  };
}

export interface SearchInput {
  location: string;
  status?: StatusKey;
  price_min?: number;
  price_max?: number;
  beds_min?: number;
  baths_min?: number;
  home_types?: HomeType[];
  limit?: number;
}

/**
 * Build the gis endpoint path + params for a resolved region + filters.
 */
export function buildGisPath(
  region: { region_id: number; region_type: number },
  input: SearchInput
): string {
  const limit = input.limit ?? 40;
  const uipt =
    input.home_types && input.home_types.length > 0
      ? input.home_types.map((t) => HOME_TYPE_UIPT[t]).join(',')
      : '1,2,3,4,5,6,7,8';
  const params: Record<string, string> = {
    al: '1',
    num_homes: String(limit),
    region_id: String(region.region_id),
    region_type: String(region.region_type),
    sf: '1,2,3,5,6,7',
    start: '0',
    status: String(STATUS_CODES[input.status ?? 'for_sale']),
    uipt,
    v: '8',
  };
  if (input.price_min !== undefined) params.min_price = String(input.price_min);
  if (input.price_max !== undefined) params.max_price = String(input.price_max);
  if (input.beds_min !== undefined) params.num_beds = String(input.beds_min);
  if (input.baths_min !== undefined) params.num_baths = String(input.baths_min);
  return `/stingray/api/gis?${new URLSearchParams(params).toString()}`;
}

export function registerSearchTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_search_properties',
    {
      title: 'Search Redfin listings',
      description:
        "Search Redfin listings by location (city, ZIP, neighborhood, or address) and optional filters. Resolves the location via Redfin's autocomplete then queries the gis API. Returns matching properties with price, beds/baths, sqft, year built, address, and the Redfin home URL. v0.1.0 supports `for_sale` status only — for-rent and recently-sold live on separate Redfin URL paths. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Search Redfin listings',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        location: z
          .string()
          .describe(
            'Free-text location: city, ZIP, neighborhood, or address (e.g. "Brooklyn, NY", "94110", "Park Slope")'
          ),
        status: z
          .enum(['for_sale', 'for_rent', 'sold'])
          .optional()
          .describe('Listing status. Only for_sale fully works in v0.1.0.'),
        price_min: z.number().int().nonnegative().optional(),
        price_max: z.number().int().nonnegative().optional(),
        beds_min: z.number().int().nonnegative().optional(),
        baths_min: z.number().int().nonnegative().optional(),
        home_types: z
          .array(
            z.enum([
              'house',
              'condo',
              'townhouse',
              'multi_family',
              'manufactured',
              'land',
            ])
          )
          .optional()
          .describe('Restrict to one or more property types.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max listings to return (default 40).'),
      },
    },
    async (input) => {
      const region = await resolveRegion(client, input.location);
      if (!region) {
        throw new Error(
          `redfin_search_properties: could not resolve location "${input.location}" to a Redfin region.`
        );
      }
      const path = buildGisPath(region, input);
      const env = await client.fetchStingrayJson<{ homes?: RawHome[] }>(path);
      const raw = env.payload?.homes ?? [];
      const limit = input.limit ?? 40;
      const formatted = raw
        .map(formatHome)
        .filter((h): h is FormattedHome => h !== null)
        .slice(0, limit);
      return textResult({
        region: {
          name: region.name,
          sub_name: region.sub_name,
          region_id: region.region_id,
          region_type: region.region_type,
        },
        results: formatted,
      });
    }
  );
}
