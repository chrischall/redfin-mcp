import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import { registerGetByAddressTools } from '../../src/tools/get-by-address.js';
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

describe('redfin_get_by_address tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerGetByAddressTools(server, mockClient)
    );
  });

  it('resolves 158 Raven Blvd via autocomplete Addresses section', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '158 Raven Blvd',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221',
              },
            ],
          },
        ],
      },
    });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '158 Raven Blvd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(result.isError).toBeFalsy();

    const callPath = mockFetchStingrayJson.mock.calls[0][0] as string;
    expect(callPath).toMatch(/location-autocomplete\?/);
    // Must include the full address joined into a single query.
    expect(callPath).toMatch(/location=158\+Raven\+Blvd/);
    expect(callPath).toMatch(/Lake\+Lure/);
    expect(callPath).toMatch(/28746/);

    const parsed = parseToolResult<{
      resolved: boolean;
      url: string;
      home_id: string;
      street_address: string;
      city: string;
      state: string;
      zip: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221'
    );
    expect(parsed.home_id).toBe('112653221');
    expect(parsed.street_address).toBe('158 Raven Blvd');
    expect(parsed.city).toBe('Lake Lure');
    expect(parsed.state).toBe('NC');
    expect(parsed.zip).toBe('28746');
  });

  it('resolves 102 Havnaers Point in Lake Lure', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '102 Havnaers Point',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/102-Havnaers-Point-28746/home/112682721',
              },
            ],
          },
        ],
      },
    });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '102 Havnaers Point',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    const parsed = parseToolResult<{
      resolved: boolean;
      home_id: string;
      url: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.home_id).toBe('112682721');
    expect(parsed.url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/102-Havnaers-Point-28746/home/112682721'
    );
  });

  it('degrades to resolved=false when no Addresses match (all variants exhausted)', async () => {
    // The implementation now also retries suffix-expansion variants.
    // "999 Nonexistent Way" → Way has no alternate, so this is one
    // call. Set mockResolvedValue (not Once) so any variant call gets
    // an empty response.
    mockFetchStingrayJson.mockResolvedValue({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Places',
            rows: [{ id: '6_30749', name: 'New York' }],
          },
        ],
      },
    });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '999 Nonexistent Way',
      city: 'Nowhere',
      state: 'NC',
      zip: '99999',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{
      resolved: boolean;
      url?: string;
      attempts?: string[];
    }>(result);
    expect(parsed.resolved).toBe(false);
    expect(parsed.url).toBeUndefined();
    expect(parsed.attempts).toBeDefined();
    expect(parsed.attempts?.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts minimal input (just address) and still hits autocomplete', async () => {
    mockFetchStingrayJson.mockResolvedValue({
      resultCode: 0,
      payload: { sections: [{ name: 'Addresses', rows: [] }] },
    });
    const result = await harness.callTool('redfin_get_by_address', {
      address: '158 Raven Blvd Lake Lure NC 28746',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{ resolved: boolean }>(result);
    expect(parsed.resolved).toBe(false);
    const callPath = mockFetchStingrayJson.mock.calls[0][0] as string;
    expect(callPath).toMatch(/location=158\+Raven\+Blvd\+Lake\+Lure\+NC\+28746/);
  });

  it('REGRESSION (#43): retries with suffix expansion when the exact form misses — Mallard Rd → Mallard Road', async () => {
    // First call (input as-typed: "Rd") returns no Addresses row,
    // simulating Redfin's strict canonical match. Second call (the
    // suffix-expansion variant: "Road") returns the home.
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { sections: [{ name: 'Addresses', rows: [] }] },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          sections: [
            {
              name: 'Addresses',
              rows: [
                {
                  name: '268 Mallard Road',
                  subName: 'Lake Lure, NC 28746',
                  url: '/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345',
                },
              ],
            },
          ],
        },
      });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '268 Mallard Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(result.isError).toBeFalsy();

    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(2);
    // First attempt: "Rd" as typed.
    expect(mockFetchStingrayJson.mock.calls[0][0]).toMatch(
      /location=268\+Mallard\+Rd\+/
    );
    // Second attempt: "Road" expansion.
    expect(mockFetchStingrayJson.mock.calls[1][0]).toMatch(
      /location=268\+Mallard\+Road\+/
    );

    const parsed = parseToolResult<{
      resolved: boolean;
      home_id: string;
      matched_variant?: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.home_id).toBe('12345');
    // Caller can see WHICH variant matched.
    expect(parsed.matched_variant).toBe(
      '268 Mallard Road Lake Lure NC 28746'
    );
  });

  it('REGRESSION (#43): same regression in the reverse direction — Road → Rd', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { sections: [{ name: 'Addresses', rows: [] }] },
      })
      .mockResolvedValueOnce({
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

    const result = await harness.callTool('redfin_get_by_address', {
      address: '268 Mallard Road',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{ resolved: boolean; matched_variant?: string }>(
      result
    );
    expect(parsed.resolved).toBe(true);
    expect(parsed.matched_variant).toBe(
      '268 Mallard Rd Lake Lure NC 28746'
    );
  });

  it('propagates auth/network errors instead of reporting them as "address not found"', async () => {
    // Simulate a sign-in interstitial / WAF challenge throw from the
    // transport layer. resolveAddress never throws for "not found" — it
    // returns null. So anything that DOES throw is a real error signal
    // (auth failure, network failure, resultCode != 0) that callers
    // must see, not have silently rewritten into resolved=false.
    const authError = new Error('Redfin session not authenticated');
    mockFetchStingrayJson.mockRejectedValueOnce(authError);

    const result = await harness.callTool('redfin_get_by_address', {
      address: '158 Raven Blvd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    // The MCP SDK marshals a thrown handler error into isError: true.
    expect(result.isError).toBe(true);
    // Crucially, this must NOT degrade to a successful resolved:false
    // payload — that would hide auth failures from the caller.
    const block = result.content[0] as { text: string };
    expect(block.text).toMatch(/session not authenticated/i);
  });

  // ----- Search-fallback rung (#75) -----

  it('SEARCH FALLBACK (#75): autocomplete misses, gis search returns 1 hit matching street tokens → resolved + matched_via=search_fallback', async () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (q === 'Lake Lure NC') {
          return {
            resultCode: 0,
            payload: {
              sections: [
                {
                  name: 'Places',
                  rows: [
                    {
                      id: '2_555',
                      name: 'Lake Lure',
                      subName: 'NC, USA',
                      url: '/city/555/NC/Lake-Lure',
                    },
                  ],
                },
              ],
            },
          };
        }
        return {
          resultCode: 0,
          payload: { sections: [{ name: 'Addresses', rows: [] }] },
        };
      }
      if (path.startsWith('/stingray/api/gis')) {
        return {
          resultCode: 0,
          payload: {
            serviceRegionName: 'Lake-Lure',
            homes: [
              {
                propertyId: 99001,
                url: '/NC/Lake-Lure/212-Ridgeway-Rd-28746/home/99001',
                streetLine: { value: '212 Ridgeway Rd' },
                city: 'Lake Lure',
                state: 'NC',
                zip: '28746',
              },
            ],
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '212 Ridgeway Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(result.isError).toBeFalsy();

    const parsed = parseToolResult<{
      resolved: boolean;
      home_id: string;
      url: string;
      matched_via: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.home_id).toBe('99001');
    expect(parsed.matched_via).toBe('search_fallback');
  });

  it('SEARCH FALLBACK: the opposite-directional house is rejected, not returned (realty-core 0.4.8)', async () => {
    // The gis pool holds only 126 S Main St. realty-core <=0.4.2 ignored
    // directionals, so "126 N Main St" passed the wrong-house gate with a
    // perfect score and the tool resolved to the wrong house; 0.4.8 treats
    // N vs S as a different street, so the rung (and the tool) misses.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (q === 'Lake Lure NC') {
          return {
            resultCode: 0,
            payload: {
              sections: [
                {
                  name: 'Places',
                  rows: [
                    { id: '2_555', name: 'Lake Lure', subName: 'NC, USA', url: '/city/555/NC/Lake-Lure' },
                  ],
                },
              ],
            },
          };
        }
        return { resultCode: 0, payload: { sections: [{ name: 'Addresses', rows: [] }] } };
      }
      if (path.startsWith('/stingray/api/gis')) {
        return {
          resultCode: 0,
          payload: {
            serviceRegionName: 'Lake-Lure',
            homes: [
              {
                propertyId: 99126,
                url: '/NC/Lake-Lure/126-S-Main-St-28746/home/99126',
                streetLine: { value: '126 S Main St' },
                city: 'Lake Lure',
                state: 'NC',
                zip: '28746',
              },
            ],
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '126 N Main St',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{ resolved: boolean; home_id?: string }>(result);
    expect(parsed.home_id).not.toBe('99126');
    expect(parsed.resolved).toBe(false);
  });

  it('SEARCH FALLBACK: a unit-bearing address still resolves to the street listing (realty-core 0.4.8)', async () => {
    // gis homes carry the street line only. realty-core 0.4.7 anchored on
    // EVERY number, so the unit id "5" in "Apt 5" had to appear in the
    // candidate and the wrong-house gate rejected the right house.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (q === 'Lake Lure NC') {
          return {
            resultCode: 0,
            payload: {
              sections: [
                {
                  name: 'Places',
                  rows: [
                    { id: '2_555', name: 'Lake Lure', subName: 'NC, USA', url: '/city/555/NC/Lake-Lure' },
                  ],
                },
              ],
            },
          };
        }
        return { resultCode: 0, payload: { sections: [{ name: 'Addresses', rows: [] }] } };
      }
      if (path.startsWith('/stingray/api/gis')) {
        return {
          resultCode: 0,
          payload: {
            serviceRegionName: 'Lake-Lure',
            homes: [
              {
                propertyId: 99001,
                url: '/NC/Lake-Lure/212-Ridgeway-Rd-28746/home/99001',
                streetLine: { value: '212 Ridgeway Rd' },
                city: 'Lake Lure',
                state: 'NC',
                zip: '28746',
              },
            ],
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '212 Ridgeway Rd Apt 5',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{ resolved: boolean; home_id?: string; matched_via?: string }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.home_id).toBe('99001');
    expect(parsed.matched_via).toBe('search_fallback');
  });

  it('SEARCH FALLBACK (#75): clean autocomplete hit → matched_via=autocomplete (back-compat)', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '158 Raven Blvd',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221',
              },
            ],
          },
        ],
      },
    });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '158 Raven Blvd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{
      resolved: boolean;
      matched_via: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.matched_via).toBe('autocomplete');
  });

  it('SEARCH FALLBACK (#75): region resolution fails → resolved=false with informative error context', async () => {
    // autocomplete misses on the address AND on the city+state region
    // query. The search-fallback rung cannot proceed, so the tool
    // degrades to resolved=false (not throw) with attempts surfaced.
    mockFetchStingrayJson.mockResolvedValue({
      resultCode: 0,
      payload: { sections: [{ name: 'Addresses', rows: [] }] },
    });
    const result = await harness.callTool('redfin_get_by_address', {
      address: '999 Bogus Way',
      city: 'Notarealcity',
      state: 'NC',
      zip: '99999',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{
      resolved: boolean;
      attempts?: string[];
    }>(result);
    expect(parsed.resolved).toBe(false);
    expect(parsed.attempts).toBeDefined();
  });

  it('does NOT add matched_variant when the input as-typed matched', async () => {
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
    const result = await harness.callTool('redfin_get_by_address', {
      address: '268 Mallard Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    const parsed = parseToolResult<{ matched_variant?: string }>(result);
    expect(parsed.matched_variant).toBeUndefined();
    // Only the first attempt fired — no need to retry once we hit.
    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(1);
  });
});
