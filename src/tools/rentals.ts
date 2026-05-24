import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';

/**
 * Redfin's web app calls `/stingray/api/home/comparable-rentals` from
 * the property page to surface "what could this rent for" data. The
 * inputs are: rentEstimateLow, rentEstimateHigh, latitude, longitude,
 * propertyId. The first three come from the property's own rent
 * estimate; this tool requires the caller to pass them since they're
 * not readily derived without a prior `redfin_get_property` call.
 *
 * Verified live 2026-05-23.
 */

interface RawRentalComp {
  propertyId?: number;
  listingId?: number;
  url?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zip?: string;
  monthlyRent?: { amount?: number; level?: number };
  beds?: number;
  baths?: number;
  sqFt?: { value?: number } | number;
  distance?: { value?: number };
  isActive?: boolean;
}

interface ComparableRentalsPayload {
  comparableRentals?: RawRentalComp[];
}

function unwrap<T>(x: T | { value?: T } | undefined): T | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'object' && 'value' in (x as object)) {
    return (x as { value?: T }).value;
  }
  return x as T;
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
    address: raw.streetAddress,
    city: raw.city,
    state: raw.state,
    zip: raw.zip,
    monthly_rent: raw.monthlyRent?.amount,
    beds: raw.beds,
    baths: raw.baths,
    sqft: unwrap(raw.sqFt),
    distance_miles: raw.distance?.value,
    is_active: raw.isActive,
  };
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
        "Find nearby rental comparables for a given property: nearby active rental listings with similar bed/bath/sqft, including monthly rent, distance, and the Redfin URL. Useful for estimating what a property could rent for, or for finding rentals near a home you're considering. Inputs are the rent estimate range + lat/lng + propertyId — typically taken from the upstream `redfin_get_property` (or read from the property page directly).",
      annotations: {
        title: 'Get comparable rentals near a Redfin property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        property_id: z.number().int().positive(),
        latitude: z.number(),
        longitude: z.number(),
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
      },
    },
    async ({
      property_id,
      latitude,
      longitude,
      rent_estimate_low,
      rent_estimate_high,
    }) => {
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
      const comps = env.payload?.comparableRentals ?? [];
      return textResult({
        property_id,
        count: comps.length,
        rentals: comps.map(formatRentalComp),
      });
    }
  );
}
