import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import {
  assertRegionMatches,
  buildGisPath,
  formatHome,
  registerSearchTools,
  type RawHome,
} from '../../src/tools/search.js';
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

describe('formatHome', () => {
  it('extracts canonical fields from a raw gis home', () => {
    const raw: RawHome = {
      propertyId: 40732555,
      listingId: 215885171,
      mlsId: { value: 'MLS-1234' },
      mlsStatus: 'Active',
      url: '/NY/Brooklyn/42-Monroe-St-11238/home/40732555',
      streetLine: { value: '42 Monroe St' },
      city: 'Brooklyn',
      state: 'NY',
      zip: '11238',
      price: 2697500,
      beds: 4,
      baths: 2,
      sqFt: { value: 2300 },
      pricePerSqFt: { value: 1173 },
      yearBuilt: { value: 1899 },
      latLong: { value: { latitude: 40.68, longitude: -73.95 } },
    };
    const f = formatHome(raw);
    expect(f).toMatchObject({
      property_id: 40732555,
      listing_id: 215885171,
      mls_id: 'MLS-1234',
      status: 'Active',
      url: 'https://www.redfin.com/NY/Brooklyn/42-Monroe-St-11238/home/40732555',
      address: '42 Monroe St, Brooklyn, NY, 11238',
      price: 2697500,
      sqft: 2300,
      price_per_sqft: 1173,
      year_built: 1899,
      latitude: 40.68,
      longitude: -73.95,
    });
  });

  it('returns null when propertyId is missing', () => {
    expect(formatHome({} as RawHome)).toBeNull();
  });

  it('synthesizes a /home/<id> URL when raw.url is absent', () => {
    const f = formatHome({ propertyId: 42 });
    expect(f?.url).toBe('https://www.redfin.com/home/42');
  });

  it('handles raw streetLine as a plain string (not value-wrapper)', () => {
    const f = formatHome({
      propertyId: 1,
      streetLine: '1 Main St',
      city: 'X',
      state: 'NY',
      zip: '12345',
    });
    expect(f?.street).toBe('1 Main St');
    expect(f?.address).toBe('1 Main St, X, NY, 12345');
  });
});

describe('buildGisPath', () => {
  const region = { region_id: 30749, region_type: 6 };

  it('encodes the basic region + default uipt', () => {
    const path = buildGisPath(region, { location: 'NYC' });
    expect(path).toMatch(/^\/stingray\/api\/gis\?/);
    expect(path).toMatch(/region_id=30749/);
    expect(path).toMatch(/region_type=6/);
    expect(path).toMatch(/uipt=1%2C2%2C3%2C4%2C5%2C6%2C7%2C8/);
    expect(path).toMatch(/num_homes=40/);
  });

  it('honors limit', () => {
    const path = buildGisPath(region, { location: 'x', limit: 5 });
    expect(path).toMatch(/num_homes=5/);
  });

  it('encodes price min/max', () => {
    const path = buildGisPath(region, {
      location: 'x',
      price_min: 500000,
      price_max: 1_500_000,
    });
    expect(path).toMatch(/min_price=500000/);
    expect(path).toMatch(/max_price=1500000/);
  });

  it('translates home_types into the right uipt CSV', () => {
    const path = buildGisPath(region, {
      location: 'x',
      home_types: ['condo', 'townhouse'],
    });
    expect(path).toMatch(/uipt=2%2C3/);
  });

  it('encodes beds/baths minimums', () => {
    const path = buildGisPath(region, {
      location: 'x',
      beds_min: 3,
      baths_min: 2,
    });
    expect(path).toMatch(/num_beds=3/);
    expect(path).toMatch(/num_baths=2/);
  });
});

describe('assertRegionMatches', () => {
  const region = {
    name: 'New York',
    sub_name: 'New York, NY, USA',
    region_id: 30749,
    region_type: 2,
  };

  it('passes when serviceRegionName shares a non-trivial token with the requested name', () => {
    expect(() =>
      assertRegionMatches(region, 'new-york-east')
    ).not.toThrow();
  });

  it('passes when serviceRegionName is missing (defensive — never false-alarm)', () => {
    expect(() => assertRegionMatches(region, undefined)).not.toThrow();
  });

  it('throws when serviceRegionName is unrelated (Brooklyn → Seattle fallback)', () => {
    expect(() =>
      assertRegionMatches(
        {
          name: 'Brooklyn',
          sub_name: 'New York, NY, USA',
          region_id: 219258,
          region_type: 6,
        },
        'arbor-heights' // Seattle neighborhood — gis fell back
      )
    ).toThrow(/doesn't fully support this region/i);
  });

  it('ignores noise state/country tokens (ny, usa) when matching', () => {
    // Without the noise filter, "ny, usa" would falsely match many regions.
    expect(() =>
      assertRegionMatches(region, 'ny-usa-something-else')
    ).toThrow();
  });
});

describe('redfin_search_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSearchTools(server, mockClient)
    );
  });

  it('resolves location via autocomplete then queries gis', async () => {
    // First call: autocomplete. Second call: gis.
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          sections: [
            {
              name: 'Places',
              rows: [
                {
                  id: '6_30749',
                  name: 'New York',
                  subName: 'New York, NY, USA',
                  url: '/city/30749/NY/New-York',
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          serviceRegionName: 'new-york-city',
          homes: [
            {
              propertyId: 1,
              listingId: 100,
              streetLine: { value: '1 Main' },
              city: 'X',
              state: 'NY',
              zip: '12345',
              price: 100,
              beds: 2,
              baths: 1,
            },
            {
              propertyId: 2,
              streetLine: { value: '2 Main' },
              city: 'X',
              state: 'NY',
              zip: '12345',
              price: 200,
            },
          ],
        },
      });

    const result = await harness.callTool('redfin_search_properties', {
      location: 'NYC',
      price_max: 500_000,
    });
    expect(result.isError).toBeFalsy();

    const autoPath = mockFetchStingrayJson.mock.calls[0][0] as string;
    expect(autoPath).toMatch(/location-autocomplete\?.*location=NYC/);
    const gisPath = mockFetchStingrayJson.mock.calls[1][0] as string;
    expect(gisPath).toMatch(/stingray\/api\/gis\?/);
    expect(gisPath).toMatch(/region_id=30749/);
    expect(gisPath).toMatch(/max_price=500000/);

    const parsed = parseToolResult<{
      region: { name: string };
      results: Array<{ property_id: number }>;
    }>(result);
    expect(parsed.region.name).toBe('New York');
    expect(parsed.results.map((r) => r.property_id)).toEqual([1, 2]);
  });

  it('throws when the location cannot be resolved', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { sections: [{ name: 'Places', rows: [] }] },
    });
    const result = await harness.callTool('redfin_search_properties', {
      location: 'nonexistent-place-xyz',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/could not resolve location/i);
  });

  it('respects limit', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          sections: [
            {
              name: 'Places',
              rows: [{ id: '6_1', name: 'X', url: '/x' }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          serviceRegionName: 'x',
          homes: Array.from({ length: 10 }, (_, i) => ({ propertyId: i + 1 })),
        },
      });
    const result = await harness.callTool('redfin_search_properties', {
      location: 'x',
      limit: 3,
    });
    const parsed = parseToolResult<{ results: unknown[] }>(result);
    expect(parsed.results).toHaveLength(3);
  });

  it('throws a helpful error when gis falls back to an unrelated region', async () => {
    // The Brooklyn neighborhood (6_219258) case in production: autocomplete
    // resolves correctly, gis returns Seattle ("arbor-heights").
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          sections: [
            {
              name: 'Places',
              rows: [
                {
                  id: '6_219258',
                  name: 'Brooklyn',
                  subName: 'New York, NY, USA',
                  url: '/neighborhood/219258/NY/New-York/Brooklyn',
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          serviceRegionName: 'arbor-heights',
          homes: [{ propertyId: 99, city: 'Seattle', state: 'WA' }],
        },
      });

    const result = await harness.callTool('redfin_search_properties', {
      location: 'Brooklyn, NY',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/doesn't fully support this region/i);
    expect(text).toMatch(/region_id \+ region_type directly/);
  });
});
