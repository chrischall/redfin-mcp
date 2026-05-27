import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import {
  InvalidPropertyUrlError,
  buildCanonicalUrl,
  extractPropertyIdFromUrl,
  format,
  registerPropertyTools,
  resolveIds,
} from '../../src/tools/properties.js';
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

describe('extractPropertyIdFromUrl', () => {
  it('finds the /home/<id> segment in a canonical URL', () => {
    expect(
      extractPropertyIdFromUrl(
        'https://www.redfin.com/NY/Brooklyn/42-Monroe-St-11238/home/40732555'
      )
    ).toBe('40732555');
  });

  it('returns null for a URL missing the /home/<id> segment', () => {
    expect(
      extractPropertyIdFromUrl('/NC/Lake-Lure/268-Mallard-Rd-28746')
    ).toBeNull();
  });

  it('handles trailing slash + query string', () => {
    expect(
      extractPropertyIdFromUrl('/NY/Brooklyn/foo/home/12345/?ref=share')
    ).toBe('12345');
  });
});

describe('resolveIds URL validation', () => {
  it('throws InvalidPropertyUrlError when url lacks /home/<id> segment', async () => {
    await expect(
      resolveIds(mockClient, {
        url: '/NC/Lake-Lure/268-Mallard-Rd-28746',
      })
    ).rejects.toBeInstanceOf(InvalidPropertyUrlError);
    // We bailed early — no initialInfo call.
    expect(mockFetchStingrayJson).not.toHaveBeenCalled();
  });

  it('proceeds past validation when the URL has a /home/<id> segment', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { propertyId: 42, listingId: 100 },
    });
    const ids = await resolveIds(mockClient, {
      url: '/NY/Brooklyn/foo/home/42',
    });
    expect(ids.propertyId).toBe(42);
    expect(ids.listingId).toBe(100);
  });

  it('throws a hint-laden error when initialInfo returns no IDs for a well-formed URL', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {},
    });
    await expect(
      resolveIds(mockClient, { url: '/NY/Brooklyn/foo/home/42' })
    ).rejects.toThrow(/may have been delisted/);
  });

  it('skips initialInfo when property_id + listing_id are provided', async () => {
    const ids = await resolveIds(mockClient, {
      property_id: 42,
      listing_id: 100,
    });
    expect(ids.propertyId).toBe(42);
    expect(mockFetchStingrayJson).not.toHaveBeenCalled();
  });
});

describe('buildCanonicalUrl', () => {
  it('builds /<STATE>/<City>/<Street>-<ZIP>/home/<id> with dashes for spaces', () => {
    const url = buildCanonicalUrl(
      {
        streetAddress: { assembledAddress: '268 Mallard Rd' },
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      },
      12345
    );
    expect(url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345'
    );
  });

  it('accepts streetAddress as a plain string', () => {
    const url = buildCanonicalUrl(
      { streetAddress: '42 Monroe St', city: 'Brooklyn', state: 'NY', zip: '11238' },
      40732555
    );
    expect(url).toBe(
      'https://www.redfin.com/NY/Brooklyn/42-Monroe-St-11238/home/40732555'
    );
  });

  it('returns null when any address part is missing', () => {
    expect(
      buildCanonicalUrl({ streetAddress: 'x', city: 'X', state: 'NY' }, 1)
    ).toBeNull();
    expect(
      buildCanonicalUrl({ streetAddress: 'x', state: 'NY', zip: '1' }, 1)
    ).toBeNull();
    expect(buildCanonicalUrl(undefined, 1)).toBeNull();
    expect(
      buildCanonicalUrl(
        { streetAddress: 'x', city: 'X', state: 'NY', zip: '1' },
        undefined
      )
    ).toBeNull();
  });

  it('collapses multiple consecutive whitespace into a single dash', () => {
    const url = buildCanonicalUrl(
      {
        streetAddress: '155  Quail   Cove Blvd',
        city: 'Lake  Lure',
        state: 'NC',
        zip: '28746',
      },
      77
    );
    expect(url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/155-Quail-Cove-Blvd-28746/home/77'
    );
  });
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
    // Now hits both ATF and BTF in parallel — was 1 call, now 2.
    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(2);
    expect(mockFetchStingrayJson.mock.calls[0][0]).toMatch(
      /aboveTheFold\?propertyId=99/
    );
  });

  it('with property_id + listing_id: returns canonical full URL (not /home/<id> short form)', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        addressSectionInfo: {
          streetAddress: { assembledAddress: '268 Mallard Rd' },
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        },
      },
    });

    const result = await harness.callTool('redfin_get_property', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{ url: string }>(result);
    expect(parsed.url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345'
    );
  });

  it('falls back to /home/<id> when ATF address data is incomplete', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { addressSectionInfo: { streetAddress: '5 X St' } }, // no city/state/zip
    });

    const result = await harness.callTool('redfin_get_property', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{ url: string }>(result);
    expect(parsed.url).toBe('https://www.redfin.com/home/12345');
  });

  it('errors when neither url nor property_id+listing_id provided', async () => {
    const result = await harness.callTool('redfin_get_property', {});
    expect(result.isError).toBeTruthy();
  });

  it('errors with InvalidPropertyUrlError when URL has no /home/<id> segment', async () => {
    const result = await harness.callTool('redfin_get_property', {
      url: '/NC/Lake-Lure/268-Mallard-Rd-28746',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/doesn't contain the required `\/home\/<propertyId>`/);
    // Bailed before initialInfo — no network call.
    expect(mockFetchStingrayJson).not.toHaveBeenCalled();
  });

  it('errors with the delisted/slug-change hint when initialInfo returns no IDs for a well-formed URL', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {},
    });
    const result = await harness.callTool('redfin_get_property', {
      url: '/NY/Brooklyn/foo/home/42',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/may have been delisted/);
  });

  it('omits `description` by default and surfaces `extracted_features` when prose is present', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        addressSectionInfo: { streetAddress: '268 Mallard Rd', city: 'Lake Lure', state: 'NC', zip: '28746' },
        mainHouseInfo: {
          publicRemarksParagraph:
            'Stunning waterfront retreat with hot tub and unfinished basement. Located in Rumbling Bald.',
        },
      },
    });
    const result = await harness.callTool('redfin_get_property', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{
      description?: string;
      extracted_features?: {
        lake_front: boolean;
        hot_tub: boolean;
        basement: string | null;
        community: string | null;
      };
    }>(result);
    expect(parsed.description).toBeUndefined();
    expect(parsed.extracted_features).toBeDefined();
    expect(parsed.extracted_features?.lake_front).toBe(true);
    expect(parsed.extracted_features?.hot_tub).toBe(true);
    expect(parsed.extracted_features?.basement).toBe('unfinished');
    expect(parsed.extracted_features?.community).toBe('Rumbling Bald');
  });

  it('emits `description` when include_description=true is set', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        addressSectionInfo: { streetAddress: '268 Mallard Rd' },
        mainHouseInfo: { publicRemarksParagraph: 'Beautiful home.' },
      },
    });
    const result = await harness.callTool('redfin_get_property', {
      property_id: 12345,
      listing_id: 99,
      include_description: true,
    });
    const parsed = parseToolResult<{ description?: string }>(result);
    expect(parsed.description).toBe('Beautiful home.');
  });

  it('omits `extracted_features` when no prose is present', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        addressSectionInfo: { streetAddress: '268 Mallard Rd' },
      },
    });
    const result = await harness.callTool('redfin_get_property', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{ extracted_features?: unknown }>(result);
    expect(parsed.extracted_features).toBeUndefined();
  });

  it('emits `portal_url_hyperlink`, `hoa_monthly_usd` and `price_drop_*` derived fields', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        addressSectionInfo: {
          streetAddress: { assembledAddress: '268 Mallard Rd' },
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
          latestPriceInfo: { amount: 480_000 },
          previousPriceInfo: { amount: 500_000 },
        },
        mainHouseInfo: {
          hoaDues: { amount: 4967, frequency: 'Annually' },
        },
      },
    });
    const result = await harness.callTool('redfin_get_property', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{
      portal_url_hyperlink: string;
      previous_list_price: number;
      price_drop_amount: number;
      price_drop_percent: number;
      hoa_monthly_usd: number;
    }>(result);
    expect(parsed.portal_url_hyperlink).toBe(
      '=HYPERLINK("https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345","Redfin")'
    );
    expect(parsed.previous_list_price).toBe(500_000);
    expect(parsed.price_drop_amount).toBe(20_000);
    expect(parsed.price_drop_percent).toBe(4.0);
    expect(parsed.hoa_monthly_usd).toBe(414); // 4967/12 rounded
  });

  it('surfaces last_sold_* from belowTheFold price history (#50)', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        // ATF
        resultCode: 0,
        payload: { addressSectionInfo: { streetAddress: 'x' } },
      })
      .mockResolvedValueOnce({
        // BTF
        resultCode: 0,
        payload: {
          propertyHistoryInfo: {
            events: [
              {
                eventDescription: 'Sold (Public Records)',
                eventDate: 1_700_000_000_000,
                price: 550_000,
              },
              { eventDescription: 'Listed', eventDate: 1_600_000_000_000 },
            ],
          },
          publicRecordsInfo: { taxInfo: { taxesDue: 5400 } },
        },
      });
    const result = await harness.callTool('redfin_get_property', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{
      last_sold_date: string;
      last_sold_price: number;
      tax_annual: number;
      tax_status: string | null;
    }>(result);
    expect(parsed.last_sold_price).toBe(550_000);
    expect(parsed.last_sold_date).toBe('2023-11-14');
    expect(parsed.tax_annual).toBe(5400);
    expect(parsed.tax_status).toBeNull();
  });

  it('nulls out tax_annual when raw is 0/1 placeholder (#36)', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { addressSectionInfo: { streetAddress: 'x' } },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { publicRecordsInfo: { taxInfo: { taxesDue: 1 } } },
      });
    const result = await harness.callTool('redfin_get_property', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{
      tax_annual: number | null;
      tax_status: string | null;
    }>(result);
    expect(parsed.tax_annual).toBeNull();
    expect(parsed.tax_status).toBe('not_yet_assessed');
  });

  it('emits address_alternates when MLS-feed addresses differ from primary (#42)', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        addressSectionInfo: {
          streetAddress: '109 Overlook Point Ln',
          city: 'X',
          state: 'NC',
          zip: '28746',
        },
        mainHouseInfo: {
          unparsedAddress: '169 Overlook Point Ln, X, NC 28746',
        },
      },
    });
    const result = await harness.callTool('redfin_get_property', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{ address_alternates?: string[] }>(result);
    expect(parsed.address_alternates).toEqual([
      '169 Overlook Point Ln, X, NC 28746',
    ]);
  });
});
