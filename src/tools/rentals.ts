import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { RedfinClient } from '../client.js';
import { minifiedResult, unwrapValue as unwrap } from '../mcp.js';

/**
 * Redfin's web app calls `/stingray/api/home/comparable-rentals` from
 * the property page to surface "what could this rent for" data. The
 * inputs are: rentEstimateLow, rentEstimateHigh, latitude, longitude,
 * propertyId. The rent estimate bounds come from the property's own rent
 * estimate, which `redfin_get_property` does NOT surface (no verified
 * fixture of Redfin's rental-estimate payload yet), so the caller must
 * supply them; lat/lng and propertyId do come from `redfin_get_property`.
 *
 * Verified live 2026-05-23.
 */

interface RawRentalComp {
  propertyId?: number;
  listingId?: number;
  url?: string;
  streetAddress?: string;
  streetLine?: { value?: string } | string;
  rentPrice?: number | { value?: number };
  price?: number | { value?: number };
  rentEstimate?: number | { value?: number };
  city?: string;
  state?: string;
  zip?: string;
  monthlyRent?: { amount?: number; level?: number };
  beds?: number;
  baths?: number;
  sqFt?: { value?: number } | number;
  distance?: { value?: number };
  isActive?: boolean;
  rentRange?: { min?: number; max?: number };
}

/** The nested comp shape Redfin sends under `homes` (~Oct 2026). */
interface NestedRentalComp {
  homeData?: {
    propertyId?: number | string;
    listingId?: number | string;
    url?: string;
    beds?: number;
    baths?: number;
    addressInfo?: {
      formattedStreetLine?: string;
      city?: string;
      state?: string;
      zip?: string;
      centroid?: { centroid?: { latitude?: number; longitude?: number } };
    };
    sqftInfo?: { amount?: number };
  };
  rentalExtension?: {
    propertyName?: string;
    rentPriceRange?: { min?: number; max?: number };
    bedRange?: { min?: number; max?: number };
    bathRange?: { min?: number; max?: number };
    sqftRange?: { min?: number; max?: number };
  };
}

function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return Math.round(3958.8 * 2 * Math.asin(Math.sqrt(a)) * 100) / 100;
}

/** Flatten a nested comp into the flat shape `formatRentalComp` reads. */
export function flattenNestedComp(
  c: NestedRentalComp,
  origin?: { latitude: number; longitude: number }
): RawRentalComp {
  const h = c.homeData ?? {};
  const x = c.rentalExtension ?? {};
  const a = h.addressInfo ?? {};
  const pt = a.centroid?.centroid;
  const rent = x.rentPriceRange;
  const toNum = (v: number | string | undefined) => (v === undefined ? undefined : Number(v));
  return {
    propertyId: toNum(h.propertyId),
    listingId: toNum(h.listingId),
    url: h.url,
    streetAddress: a.formattedStreetLine ?? x.propertyName,
    city: a.city,
    state: a.state,
    zip: a.zip,
    // A building advertises a range; report its low end, the range goes alongside.
    monthlyRent: rent?.min !== undefined ? { amount: rent.min } : undefined,
    rentRange: rent,
    beds: h.beds ?? x.bedRange?.min,
    baths: h.baths ?? x.bathRange?.min,
    sqFt: h.sqftInfo?.amount ?? x.sqftRange?.min,
    distance:
      origin && pt?.latitude !== undefined && pt?.longitude !== undefined
        ? { value: milesBetween(origin.latitude, origin.longitude, pt.latitude, pt.longitude) }
        : undefined,
  };
}

interface ComparableRentalsPayload {
  comparableRentals?: RawRentalComp[];
  /** The array's name since ~Oct 2026. */
  homes?: (RawRentalComp & NestedRentalComp)[];
  numMatchedHomes?: number;
}

export interface FormattedRentalComp {
  property_id?: number;
  listing_id?: number;
  url?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  monthly_rent?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  distance_miles?: number;
  is_active?: boolean;
  /** When the comp is a building listing a range of rents. */
  rent_range?: { min?: number; max?: number };
}

export function formatRentalComp(raw: RawRentalComp): FormattedRentalComp {
  return {
    property_id: raw.propertyId,
    listing_id: raw.listingId,
    url: raw.url
      ? raw.url.startsWith('http')
        ? raw.url
        : `https://www.redfin.com${raw.url}`
      : undefined,
    address: raw.streetAddress ?? unwrap(raw.streetLine),
    city: raw.city,
    state: raw.state,
    zip: raw.zip,
    monthly_rent:
      raw.monthlyRent?.amount ?? unwrap(raw.rentPrice) ?? unwrap(raw.price) ?? unwrap(raw.rentEstimate),
    beds: raw.beds,
    baths: raw.baths,
    sqft: unwrap(raw.sqFt),
    distance_miles: raw.distance?.value,
    is_active: raw.isActive,
    ...(raw.rentRange && raw.rentRange.max !== raw.rentRange.min ? { rent_range: raw.rentRange } : {}),
  };
}

/** Two levels of key names, for diagnosing an unfamiliar payload. */
function describeKeys(o: unknown): string {
  if (!o || typeof o !== 'object') return String(o);
  return Object.entries(o as Record<string, unknown>)
    .map(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) ? `${k}{${Object.keys(v).join(',')}}` : k
    )
    .join(', ');
}

export function registerRentalsTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_comparable_rentals',
    {
      title: 'Get comparable rentals near a Redfin property',
      description:
        "Find nearby rental comparables for a given property: nearby active rental listings with similar bed/bath/sqft, including monthly rent, distance, and the Redfin URL. Useful for estimating what a property could rent for, or for finding rentals near a home you're considering. Inputs are the rent estimate range + lat/lng + propertyId. `redfin_get_property` supplies property_id, latitude and longitude, but it does not return a rent estimate — take the range from the Redfin property page's rental estimate or another source (e.g. a Zillow rent Zestimate), or pass a deliberately wide range around a known rent. The range is sent to Redfin as a filter, so a wrong or invented range narrows the comps; low must not exceed high.",
      annotations: {
        title: 'Get comparable rentals near a Redfin property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        property_id: z.number().int().positive(),
        latitude: z.number().min(-90).max(90).describe('Property latitude (from redfin_get_property).'),
        longitude: z.number().min(-180).max(180).describe('Property longitude (from redfin_get_property).'),
        rent_estimate_low: z
          .number()
          .int()
          .positive()
          .describe(
            'Lower bound of the rent estimate. Use the same value for low+high if you only have one estimate.'
          ),
        rent_estimate_high: z
          .number()
          .int()
          .positive()
          .describe('Upper bound of the rent estimate.'),
      }),
    },
    async ({
      property_id,
      latitude,
      longitude,
      rent_estimate_low,
      rent_estimate_high,
    }) => {
      // Sent to Redfin as filter params, so a reversed range would quietly
      // return nothing useful (fleet-audit #672).
      if (rent_estimate_low > rent_estimate_high) {
        throw new Error(
          `rent_estimate_low (${rent_estimate_low}) must not exceed rent_estimate_high (${rent_estimate_high}).`
        );
      }
      const params = new URLSearchParams({
        rentEstimateLow: String(rent_estimate_low),
        rentEstimateHigh: String(rent_estimate_high),
        latitude: String(latitude),
        longitude: String(longitude),
        propertyId: String(property_id),
      });
      const env = await client.fetchStingrayJson<ComparableRentalsPayload>(
        `/stingray/api/home/comparable-rentals?${params.toString()}`
      );
      const comps = env.payload?.comparableRentals ?? env.payload?.homes ?? [];
      const rentals = comps
        .map((c) =>
          'homeData' in c || 'rentalExtension' in c
            ? flattenNestedComp(c as NestedRentalComp, { latitude, longitude })
            : (c as RawRentalComp)
        )
        .map(formatRentalComp);
      // An empty list may be a real "no comps" or a renamed payload key;
      // name what Redfin did send so the two can be told apart. Likewise
      // name a comp's fields when the rent didn't map.
      const unmapped =
        rentals.length > 0 && rentals.every((r) => r.monthly_rent === undefined)
          ? `monthly_rent did not map from Redfin's comp fields (first comp: ${describeKeys(comps[0])}).`
          : undefined;
      const note =
        unmapped ??
        (comps.length === 0
          ? env.payload && !('comparableRentals' in env.payload) && !('homes' in env.payload)
            ? `Redfin's response has no comparableRentals field (keys: ${Object.keys(env.payload).join(', ') || 'none'}); the endpoint may have changed — this is not a confirmed zero.`
            : 'Redfin returned no rental comps for this property and rent range. Try a wider rent range, or zillow rent_zestimate.'
          : undefined);
      return minifiedResult({
        property_id,
        count: comps.length,
        ...(note ? { note } : {}),
        rentals,
      });
    }
  );
}
