import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import { format, registerPropertyTools } from '../../src/tools/properties.js';
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

describe('format', () => {
  it('flattens initialInfo + aboveTheFold into one object', () => {
    const out = format(
      {
        propertyId: 42,
        listingId: 100,
        marketId: 4,
        marketName: 'NYC',
        mlsId: { value: 'MLS-1' },
        latLong: { value: { latitude: 40.6, longitude: -74.0 } },
      },
      {
        addressSectionInfo: {
          streetAddress: { assembledAddress: '1 Main St' },
          city: 'Brooklyn',
          state: 'NY',
          zip: '11238',
          beds: 3,
          baths: 2,
          sqFt: { value: 1500 },
          pricePerSqFt: { value: 600 },
          yearBuilt: { value: 1925 },
          latestPriceInfo: { amount: 900_000, label: 'List Price' },
          status: { displayValue: 'Active' },
          cumulativeDaysOnMarket: 14,
          daysOnMarketLabel: '14 days',
        },
        mediaBrowserInfo: {
          photos: [
            { photoUrls: { fullScreenPhotoUrl: 'https://x/photo.jpg' } },
          ],
        },
      },
      'https://www.redfin.com/NY/Brooklyn/42'
    );

    expect(out).toMatchObject({
      property_id: 42,
      listing_id: 100,
      market_id: 4,
      market_name: 'NYC',
      mls_id: 'MLS-1',
      url: 'https://www.redfin.com/NY/Brooklyn/42',
      address: '1 Main St, Brooklyn, NY, 11238',
      beds: 3,
      baths: 2,
      sqft: 1500,
      price_per_sqft: 600,
      year_built: 1925,
      price: 900_000,
      price_label: 'List Price',
      status: 'Active',
      cumulative_days_on_market: 14,
      latitude: 40.6,
      longitude: -74.0,
      primary_photo_url: 'https://x/photo.jpg',
    });
  });

  it('falls back from latestPriceInfo to priceInfo for price', () => {
    const out = format(
      { propertyId: 1, listingId: 2 },
      {
        addressSectionInfo: {
          streetAddress: '1 X',
          city: 'X',
          state: 'NY',
          zip: '11111',
          priceInfo: { amount: 500_000, label: 'Listed' },
        },
      },
      'https://www.redfin.com/x'
    );
    expect(out.price).toBe(500_000);
    expect(out.price_label).toBe('Listed');
  });

  it('handles streetAddress as a plain string', () => {
    const out = format(
      { propertyId: 1 },
      {
        addressSectionInfo: {
          streetAddress: '5 Plain St',
          city: 'Y',
          state: 'NY',
          zip: '11111',
        },
      },
      'https://www.redfin.com/y'
    );
    expect(out.address).toBe('5 Plain St, Y, NY, 11111');
  });

  it('omits address when nothing populated', () => {
    const out = format(null, null, 'https://www.redfin.com/h');
    expect(out.address).toBeUndefined();
    expect(out.url).toBe('https://www.redfin.com/h');
  });
});

describe('redfin_get_property tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerPropertyTools(server, mockClient)
    );
  });

  it('with url: calls initialInfo then aboveTheFold', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { propertyId: 42, listingId: 100, marketId: 4 },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          addressSectionInfo: {
            streetAddress: '1 Main',
            city: 'X',
            state: 'NY',
            zip: '11111',
            beds: 2,
            baths: 1,
          },
        },
      });

    const result = await harness.callTool('redfin_get_property', {
      url: '/NY/X/1-Main/home/42',
    });
    expect(result.isError).toBeFalsy();

    const initPath = mockFetchStingrayJson.mock.calls[0][0] as string;
    expect(initPath).toMatch(/initialInfo\?path=%2FNY%2FX%2F1-Main%2Fhome%2F42/);
    const atfPath = mockFetchStingrayJson.mock.calls[1][0] as string;
    expect(atfPath).toMatch(/aboveTheFold\?/);
    expect(atfPath).toMatch(/propertyId=42/);
    expect(atfPath).toMatch(/listingId=100/);

    const parsed = parseToolResult<{ property_id: number; beds: number }>(
      result
    );
    expect(parsed.property_id).toBe(42);
    expect(parsed.beds).toBe(2);
  });

  it('with property_id + listing_id: skips initialInfo', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { addressSectionInfo: { streetAddress: 'x', beds: 4 } },
    });

    const result = await harness.callTool('redfin_get_property', {
      property_id: 99,
      listing_id: 999,
    });
    expect(result.isError).toBeFalsy();
    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(1);
    expect(mockFetchStingrayJson.mock.calls[0][0]).toMatch(
      /aboveTheFold\?propertyId=99/
    );
  });

  it('errors when neither url nor property_id+listing_id provided', async () => {
    const result = await harness.callTool('redfin_get_property', {});
    expect(result.isError).toBeTruthy();
  });

  it('errors when initialInfo cannot resolve the URL', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {},
    });
    const result = await harness.callTool('redfin_get_property', {
      url: '/bad-url',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/initialInfo did not return propertyId/i);
  });
});
