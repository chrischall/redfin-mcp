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

  it('emits portal_url_hyperlink (#41)', () => {
    const f = formatHome({
      propertyId: 40732555,
      url: '/NY/Brooklyn/42-Monroe-St-11238/home/40732555',
    });
    expect(f?.portal_url_hyperlink).toBe(
      '=HYPERLINK("https://www.redfin.com/NY/Brooklyn/42-Monroe-St-11238/home/40732555","Redfin")'
    );
  });

  it('derives price_drop_amount + price_drop_percent (#35)', () => {
    const f = formatHome({
      propertyId: 1,
      price: 480_000,
      previousPrice: 500_000,
    });
    expect(f?.price_drop_amount).toBe(20_000);
    expect(f?.price_drop_percent).toBe(4.0);
    expect(f?.previous_list_price).toBe(500_000);
  });

  it('leaves price_drop_* null when no previous price', () => {
    const f = formatHome({ propertyId: 1, price: 480_000 });
    expect(f?.price_drop_amount).toBeNull();
    expect(f?.price_drop_percent).toBeNull();
    expect(f?.previous_list_price).toBeUndefined();
  });

  it('falls back to originalPrice when previousPrice is absent', () => {
    const f = formatHome({
      propertyId: 1,
      price: 480_000,
      originalPrice: 500_000,
    });
    expect(f?.previous_list_price).toBe(500_000);
    expect(f?.price_drop_amount).toBe(20_000);
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
      assertRegionMatches(region, { serviceRegionName: 'new-york-east' })
    ).not.toThrow();
  });

  it('passes when serviceRegionName is missing AND no homes were returned (0 results is legit)', () => {
    expect(() => assertRegionMatches(region, { homes: [] })).not.toThrow();
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
        { serviceRegionName: 'arbor-heights' }
      )
    ).toThrow(/doesn't fully support this region/i);
  });

  it('throws when serviceRegionName is absent but returned homes share no tokens with the region (Asheville → Ipswich)', () => {
    expect(() =>
      assertRegionMatches(
        {
          name: 'Asheville',
          sub_name: 'Asheville, NC, USA',
          region_id: 555,
          region_type: 2,
        },
        {
          homes: [
            { city: 'Ipswich', state: 'MA' },
            { city: 'Ipswich', state: 'MA' },
          ],
        }
      )
    ).toThrow(/silently fell back/i);
  });

  it('passes when serviceRegionName is absent but homes match the requested region', () => {
    expect(() =>
      assertRegionMatches(
        {
          name: 'Asheville',
          sub_name: 'Asheville, NC, USA',
          region_id: 555,
          region_type: 2,
        },
        { homes: [{ city: 'Asheville', state: 'NC' }] }
      )
    ).not.toThrow();
  });

  it('ignores noise state/country tokens (ny, usa) when matching', () => {
    expect(() =>
      assertRegionMatches(region, {
        serviceRegionName: 'ny-usa-something-else',
      })
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

  it('returns results=[] with a notice when gis returns 0 homes for a valid region', async () => {
    // Lake Lure NC scenario: autocomplete resolves to (2_9294), gis
    // returns rc=0 + homes=[] with no serviceRegionName. assertRegionMatches
    // passes (0 results is legit), but the handler annotates the empty
    // result so the caller knows it's likely a coverage gap not a true
    // zero-inventory situation.
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          sections: [
            {
              name: 'Places',
              rows: [
                {
                  id: '2_9294',
                  name: 'Lake Lure',
                  subName: 'Lake Lure, NC, USA',
                  url: '/city/9294/NC/Lake-Lure',
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { homes: [] },
      });

    const result = await harness.callTool('redfin_search_properties', {
      location: 'Lake Lure, NC',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{
      notice?: string;
      results: unknown[];
    }>(result);
    expect(parsed.results).toEqual([]);
    expect(parsed.notice).toMatch(/outside Redfin.*MLS coverage/i);
    expect(parsed.notice).toMatch(/Lake Lure/);
  });

  it('falls back to Addresses-section resolution for a full street-address query (#24)', async () => {
    // Real-world repro: searching for "155 Quail Cove Blvd Lake Lure NC 28746"
    // returns NO Places section, only Addresses. Old behaviour: throw
    // "could not resolve location". New behaviour: surface the matched
    // address as a single result so the caller can act on the home_id.
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '155 Quail Cove Blvd',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/155-Quail-Cove-Blvd-28746/home/112653222',
              },
            ],
          },
        ],
      },
    });

    const result = await harness.callTool('redfin_search_properties', {
      location: '155 Quail Cove Blvd Lake Lure NC 28746',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{
      resolved_as: 'address' | 'region';
      results: Array<{ property_id: number; url: string; address: string }>;
    }>(result);
    expect(parsed.resolved_as).toBe('address');
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].property_id).toBe(112653222);
    expect(parsed.results[0].url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/155-Quail-Cove-Blvd-28746/home/112653222'
    );
    expect(parsed.results[0].address).toMatch(/155 Quail Cove Blvd/);
    // gis must NOT have been called — we resolved directly via autocomplete.
    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(1);
  });

  it('throws the homes-don\'t-match-region error when serviceRegionName is absent (Asheville → Ipswich)', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          sections: [
            {
              name: 'Places',
              rows: [
                {
                  id: '2_555',
                  name: 'Asheville',
                  subName: 'Asheville, NC, USA',
                  url: '/city/555/NC/Asheville',
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          // No serviceRegionName; homes are in a totally different state.
          homes: [
            { propertyId: 1, city: 'Ipswich', state: 'MA' },
            { propertyId: 2, city: 'Ipswich', state: 'MA' },
          ],
        },
      });

    const result = await harness.callTool('redfin_search_properties', {
      location: 'Asheville, NC',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/silently fell back/i);
    expect(text).toMatch(/all 2 returned result/i); // covers the "all N" wording nit
    expect(text).toMatch(/Ipswich/);
  });

  it('CANONICAL #46 REGRESSION: ZIP 28746 returning Seattle (WA) homes → error loudly', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          sections: [
            {
              name: 'Places',
              rows: [
                {
                  id: '6_999',
                  name: 'Fremont',
                  subName: 'Seattle, WA, USA',
                  url: '/neighborhood/999/WA/Seattle/Fremont',
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          homes: [
            { propertyId: 1, city: 'Seattle', state: 'WA' },
            { propertyId: 2, city: 'Seattle', state: 'WA' },
          ],
        },
      });
    const result = await harness.callTool('redfin_search_properties', {
      location: '28746',
    });
    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/ZIP 28746 not in Redfin's coverage/);
    expect(text).toMatch(/Seattle/);
    expect(text).toMatch(/NC/); // suggested plausible state
  });

  it('emits coverage: "full" when gis returns homes', async () => {
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
          homes: [{ propertyId: 1, city: 'New York', state: 'NY', price: 100 }],
        },
      });
    const r = await harness.callTool('redfin_search_properties', {
      location: 'New York, NY',
    });
    const parsed = parseToolResult<{ coverage: string; result_cap_hit: boolean }>(
      r
    );
    expect(parsed.coverage).toBe('full');
    expect(parsed.result_cap_hit).toBe(false);
  });

  it('emits coverage: "none" when gis empty and no Addresses match (#47)', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          sections: [
            {
              name: 'Places',
              rows: [
                {
                  id: '2_1234',
                  name: 'Lake Lure',
                  subName: 'Lake Lure, NC, USA',
                  url: '/city/1234/NC/Lake-Lure',
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { homes: [] },
      });
    const r = await harness.callTool('redfin_search_properties', {
      location: 'Lake Lure, NC',
    });
    const parsed = parseToolResult<{ coverage: string; notice?: string }>(r);
    expect(parsed.coverage).toBe('none');
    expect(parsed.notice).toMatch(/coverage: none/);
  });

  it('emits coverage: "profile_only" when gis is missing but Addresses resolved', async () => {
    // resolveBoth returns { region: null, address: {...} } — handler
    // falls into the addressOnlyResult branch. The mock returns
    // ONE response (autocomplete) since the gis path isn't taken.
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '268 Mallard Rd',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345',
              },
            ],
          },
        ],
      },
    });
    const r = await harness.callTool('redfin_search_properties', {
      location: '268 Mallard Rd Lake Lure NC 28746',
    });
    const parsed = parseToolResult<{ coverage: string; resolved_as: string }>(r);
    expect(parsed.resolved_as).toBe('address');
    expect(parsed.coverage).toBe('profile_only');
  });

  it('result_cap_hit: true when gis returns 350 results AND no client-side limit truncation', async () => {
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
          homes: Array.from({ length: 350 }, (_, i) => ({
            propertyId: i + 1,
            city: 'New York',
            state: 'NY',
            price: 100,
          })),
        },
      });
    const r = await harness.callTool('redfin_search_properties', {
      location: 'New York, NY',
      limit: 400,
    });
    const parsed = parseToolResult<{ result_cap_hit: boolean; notice?: string }>(
      r
    );
    expect(parsed.result_cap_hit).toBe(true);
    expect(parsed.notice).toMatch(/hard cap/);
  });

  it('result_cap_hit: true even when some raw homes are null-filtered (missing propertyId)', async () => {
    // Regression: formatted.length === raw.length used to gate the
    // cap-hit signal. If formatHome drops any rows (e.g. one row
    // missing propertyId), the cap-hit flag was silently lost.
    // Cap-hit is a property of `raw`, not `formatted`.
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
          homes: Array.from({ length: 1000 }, (_, i) => {
            // First row lacks propertyId — formatHome will drop it,
            // so formatted.length (999) < raw.length (1000).
            if (i === 0) {
              return { city: 'New York', state: 'NY', price: 100 } as RawHome;
            }
            return {
              propertyId: i + 1,
              city: 'New York',
              state: 'NY',
              price: 100,
            } as RawHome;
          }),
        },
      });
    const r = await harness.callTool('redfin_search_properties', {
      location: 'New York, NY',
      limit: 2000,
    });
    const parsed = parseToolResult<{ result_cap_hit: boolean }>(r);
    expect(parsed.result_cap_hit).toBe(true);
  });
});
