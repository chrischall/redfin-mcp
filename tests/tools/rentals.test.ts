import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import {
  formatRentalComp,
  registerRentalsTools,
} from '../../src/tools/rentals.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchStingrayJson = vi.fn();
const mockClient = {
  fetchStingrayJson: mockFetchStingrayJson,
} as unknown as RedfinClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('formatRentalComp', () => {
  it('flattens a comp + builds absolute URL', () => {
    expect(
      formatRentalComp({
        propertyId: 1,
        listingId: 10,
        url: '/x/y/home/1',
        streetAddress: '1 Main',
        city: 'X',
        state: 'NY',
        zip: '11111',
        monthlyRent: { amount: 3200 },
        beds: 2,
        baths: 1,
        sqFt: { value: 850 },
        distance: { value: 0.4 },
        isActive: true,
      })
    ).toEqual({
      property_id: 1,
      listing_id: 10,
      url: 'https://www.redfin.com/x/y/home/1',
      address: '1 Main',
      city: 'X',
      state: 'NY',
      zip: '11111',
      monthly_rent: 3200,
      beds: 2,
      baths: 1,
      sqft: 850,
      distance_miles: 0.4,
      is_active: true,
    });
  });

  it('preserves absolute URLs', () => {
    expect(
      formatRentalComp({
        propertyId: 5,
        url: 'https://www.redfin.com/elsewhere/home/5',
      }).url
    ).toBe('https://www.redfin.com/elsewhere/home/5');
  });
});

describe('redfin_get_comparable_rentals tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerRentalsTools(server, mockClient)
    );
  });

  it('hits comparable-rentals with the right query params + returns formatted comps', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        comparableRentals: [
          {
            propertyId: 11,
            url: '/x/home/11',
            streetAddress: '11 X',
            monthlyRent: { amount: 3000 },
            beds: 2,
            baths: 1,
          },
          {
            propertyId: 22,
            url: '/y/home/22',
            streetAddress: '22 Y',
            monthlyRent: { amount: 3400 },
            beds: 3,
            baths: 2,
          },
        ],
      },
    });

    const r = await harness.callTool('redfin_get_comparable_rentals', {
      property_id: 100,
      latitude: 40.6,
      longitude: -73.95,
      rent_estimate_low: 3000,
      rent_estimate_high: 3500,
    });
    expect(r.isError).toBeFalsy();
    const calledPath = mockFetchStingrayJson.mock.calls[0][0] as string;
    expect(calledPath).toMatch(/comparable-rentals/);
    expect(calledPath).toMatch(/propertyId=100/);
    expect(calledPath).toMatch(/rentEstimateLow=3000/);
    expect(calledPath).toMatch(/rentEstimateHigh=3500/);

    const parsed = parseToolResult<{
      property_id: number;
      count: number;
      rentals: Array<{ monthly_rent: number }>;
    }>(r);
    expect(parsed.property_id).toBe(100);
    expect(parsed.count).toBe(2);
    expect(parsed.rentals.map((r) => r.monthly_rent)).toEqual([3000, 3400]);
  });

  it('returns count=0 when no comps are found', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { comparableRentals: [] },
    });
    const r = await harness.callTool('redfin_get_comparable_rentals', {
      property_id: 1,
      latitude: 0,
      longitude: 0,
      rent_estimate_low: 1000,
      rent_estimate_high: 2000,
    });
    const parsed = parseToolResult<{ count: number; rentals: unknown[] }>(r);
    expect(parsed.count).toBe(0);
    expect(parsed.rentals).toEqual([]);
  });

  it('reads the renamed `homes` array and names unmapped comp fields', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { numMatchedHomes: 1, homes: [{ propertyId: 9, streetLine: { value: '1 A St' }, mystery: 1 }] },
    });
    const r = await harness.callTool('redfin_get_comparable_rentals', {
      property_id: 100,
      latitude: 1,
      longitude: 1,
      rent_estimate_low: 1,
      rent_estimate_high: 2,
    });
    const parsed = parseToolResult<{ count: number; note?: string; rentals: Array<{ address?: string }> }>(r);
    expect(parsed.count).toBe(1);
    expect(parsed.rentals[0].address).toBe('1 A St');
    expect(parsed.note).toMatch(/mystery/);
  });

  it('flattens nested homeData/rentalExtension comps', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        homes: [
          {
            homeData: {
              propertyId: '77',
              url: '/CA/Hayward/apartment/77',
              addressInfo: {
                formattedStreetLine: '500 B St',
                city: 'Hayward',
                state: 'CA',
                zip: '94541',
                centroid: { centroid: { latitude: 37.65, longitude: -122.08 } },
              },
            },
            rentalExtension: {
              rentPriceRange: { min: 3100, max: 3400 },
              bedRange: { min: 3, max: 3 },
              bathRange: { min: 2, max: 2 },
              sqftRange: { min: 1200, max: 1300 },
            },
          },
        ],
      },
    });
    const r = await harness.callTool('redfin_get_comparable_rentals', {
      property_id: 100,
      latitude: 37.64,
      longitude: -122.08,
      rent_estimate_low: 2800,
      rent_estimate_high: 3600,
    });
    const parsed = parseToolResult<{ note?: string; rentals: Array<Record<string, unknown>> }>(r);
    expect(parsed.note).toBeUndefined();
    expect(parsed.rentals[0]).toMatchObject({
      property_id: 77,
      address: '500 B St',
      zip: '94541',
      monthly_rent: 3100,
      rent_range: { min: 3100, max: 3400 },
      beds: 3,
      baths: 2,
      sqft: 1200,
      url: 'https://www.redfin.com/CA/Hayward/apartment/77',
    });
    expect(parsed.rentals[0].distance_miles).toBeCloseTo(0.69, 1);
  });
});
