import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { FetchproxyTimeoutError } from '@chrischall/mcp-utils/fetchproxy';
import type { RedfinClient } from '../../src/client.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
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

describe('redfin_resolve_addresses tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerResolveAddressesTools(server, mockClient)
    );
  });

  it('resolves a string and a structured address, preserving input order', async () => {
    // autocomplete is a non-stingray fetch path on RedfinClient. Look at
    // src/autocomplete.ts — `resolveAddress` calls
    // `client.fetchStingrayJson` on `/stingray/do/location-autocomplete`.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      // Each call to autocomplete returns Addresses rows; emit
      // different shapes based on the location query.
      // URLSearchParams encodes ' ' as '+', so decode and normalize.
      const query = decodeURIComponent(
        (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
      );
      if (query.includes('158 Raven')) {
        return {
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
                    id: '112653221',
                  },
                ],
              },
            ],
          },
        };
      }
      if (query.includes('200 Acme')) {
        return {
          resultCode: 0,
          payload: {
            sections: [
              {
                name: 'Addresses',
                rows: [
                  {
                    name: '200 Acme Ave',
                    subName: 'Lake Lure, NC 28746',
                    url: '/NC/Lake-Lure/200-Acme-Ave-28746/home/999',
                    id: '999',
                  },
                ],
              },
            ],
          },
        };
      }
      // Unknown address — return empty
      return {
        resultCode: 0,
        payload: { sections: [{ name: 'Addresses', rows: [] }] },
      };
    });
    const r = await harness.callTool('redfin_resolve_addresses', {
      addresses: [
        '158 Raven Blvd, Lake Lure NC 28746',
        { street: '200 Acme Ave', city: 'Lake Lure', state: 'NC', zip: '28746' },
        '0 Nowhere Ln',
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      resolved: number;
      unresolved: number;
      results: Array<{ resolved: boolean; home_id?: string; url?: string }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.resolved).toBe(2);
    expect(parsed.unresolved).toBe(1);
    expect(parsed.results[0].resolved).toBe(true);
    expect(parsed.results[0].home_id).toBe('112653221');
    expect(parsed.results[1].resolved).toBe(true);
    expect(parsed.results[1].home_id).toBe('999');
    expect(parsed.results[2].resolved).toBe(false);
  });

  it('per-row error capture — autocomplete throw does not abort batch', async () => {
    let n = 0;
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      n++;
      // Make the 2nd autocomplete call throw, leave 1st and 3rd to
      // succeed with an empty Addresses section (resolved: false).
      if (n === 2) throw new Error('autocomplete went sideways');
      return {
        resultCode: 0,
        payload: { sections: [{ name: 'Addresses', rows: [] }] },
      };
    });
    const r = await harness.callTool('redfin_resolve_addresses', {
      addresses: ['a', 'b', 'c'],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      results: Array<{ resolved: boolean; error?: string }>;
    }>(r);
    expect(parsed.results.some((row) => row.error !== undefined)).toBe(true);
    expect(parsed.results.every((row) => row.resolved !== undefined)).toBe(
      true
    );
  });

  it('rejects empty addresses array', async () => {
    const r = await harness.callTool('redfin_resolve_addresses', {
      addresses: [],
    });
    expect(r.isError).toBeTruthy();
  });

  // -- TIMEOUT vs. GENUINE MISS (D2, #78 bug class) -------------------
  //
  // The reporter saw rows marked `resolved: false` from a *bridge
  // timeout* — indistinguishable from a genuine "no match". That nearly
  // recorded real properties as absent. classifyRowError gives the
  // discriminator: a timeout surfaces as a retryable `status: "timeout"`,
  // never collapsed into a silent miss.

  it('classifies a bridge timeout distinctly from a genuine no-match (D2)', async () => {
    // The address-resolution fetch times out, even after the one retry.
    mockFetchStingrayJson.mockImplementation(async () => {
      throw new FetchproxyTimeoutError({
        url: 'https://www.redfin.com/stingray/do/location-autocomplete',
        timeoutMs: 30_000,
      });
    });
    const r = await harness.callTool('redfin_resolve_addresses', {
      addresses: ['158 Raven Blvd, Lake Lure NC 28746'],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      results: Array<{
        resolved: boolean;
        status?: string;
        retryable?: boolean;
        error?: string;
      }>;
    }>(r);
    // Not resolved, but distinctly a transient timeout — NOT a real miss.
    expect(parsed.results[0].resolved).toBe(false);
    expect(parsed.results[0].status).toBe('timeout');
    expect(parsed.results[0].retryable).toBe(true);
    expect(parsed.results[0].error).toMatch(/bridge timeout after retry/);
  });

  it('retries a transient timeout once before surfacing it (#78)', async () => {
    // First autocomplete fetch times out; the retry succeeds and the row
    // resolves. retryOnceOnTimeout wraps the whole resolver ladder per row.
    let calls = 0;
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      calls++;
      if (calls === 1) {
        throw new FetchproxyTimeoutError({
          url: 'https://www.redfin.com/stingray/do/location-autocomplete',
          timeoutMs: 30_000,
        });
      }
      const query = decodeURIComponent(
        (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
      );
      if (query.includes('158 Raven')) {
        return {
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
                    id: '112653221',
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
    });
    const r = await harness.callTool('redfin_resolve_addresses', {
      addresses: ['158 Raven Blvd, Lake Lure NC 28746'],
    });
    const parsed = parseToolResult<{
      results: Array<{ resolved: boolean; home_id?: string }>;
    }>(r);
    expect(parsed.results[0].resolved).toBe(true);
    expect(parsed.results[0].home_id).toBe('112653221');
  });

  // -- OVERALL DEADLINE → partial results, never wedges (D2) ----------

  describe('overall hard deadline → partial results, never wedges (D2)', () => {
    const FAST_TUNING = { overallDeadlineMs: 200 };

    it('a single hung row is backfilled as a retryable timeout; others resolve', async () => {
      const deadlineHarness = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, FAST_TUNING)
      );
      mockFetchStingrayJson.mockImplementation(async (path: string) => {
        const query = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (query.includes('Hang')) {
          // Never settles — the wedging row.
          return new Promise(() => {});
        }
        if (query.includes('158 Raven')) {
          return {
            resultCode: 0,
            payload: {
              sections: [
                {
                  name: 'Addresses',
                  rows: [
                    {
                      name: '158 Raven Blvd',
                      subName: 'Lake Lure, NC 28746',
                      url: '/NC/Lake-Lure/158-Raven-Blvd-28746/home/111',
                      id: '111',
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
      });
      const r = await deadlineHarness.callTool('redfin_resolve_addresses', {
        addresses: [
          '158 Raven Blvd, Lake Lure NC 28746',
          '1 Hang Ln, Nowhere NC 28746',
          '158 Raven Blvd, Lake Lure NC 28746',
        ],
      });
      const parsed = parseToolResult<{
        count: number;
        pending?: number;
        results: Array<{
          resolved: boolean;
          home_id?: string;
          status?: string;
          retryable?: boolean;
          error?: string;
        }>;
      }>(r);
      // One row per input, input order preserved.
      expect(parsed.count).toBe(3);
      expect(parsed.results[0].resolved).toBe(true);
      expect(parsed.results[0].home_id).toBe('111');
      expect(parsed.results[2].resolved).toBe(true);
      // The hung row is backfilled as a retryable pending/timeout — never a
      // silent `resolved: false` miss.
      expect(parsed.results[1].resolved).toBe(false);
      expect(parsed.results[1].status).toBe('pending');
      expect(parsed.results[1].retryable).toBe(true);
      expect(parsed.pending).toBe(1);
      await deadlineHarness.close();
    }, 5000);

    it('does not poison the connection: resolves promptly despite a hung row', async () => {
      const deadlineHarness = await createTestHarness((server) =>
        registerResolveAddressesTools(server, mockClient, FAST_TUNING)
      );
      mockFetchStingrayJson.mockImplementation(async (path: string) => {
        const query = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (query.includes('Hang')) return new Promise(() => {});
        return {
          resultCode: 0,
          payload: { sections: [{ name: 'Addresses', rows: [] }] },
        };
      });
      const start = Date.now();
      const r = await deadlineHarness.callTool('redfin_resolve_addresses', {
        addresses: ['1 Hang Ln', 'x', 'y'],
      });
      const elapsed = Date.now() - start;
      expect(r.isError).toBeFalsy();
      expect(elapsed).toBeLessThan(3000);
      await deadlineHarness.close();
    }, 5000);
  });

  it('caps addresses at 100', async () => {
    const r = await harness.callTool('redfin_resolve_addresses', {
      addresses: Array.from({ length: 101 }, () => 'X'),
    });
    expect(r.isError).toBeTruthy();
  });

  // -- PARITY WITH redfin_get_by_address (issue #71) ------------------
  //
  // The single resolver runs a suffix-expansion fallback (issue #43:
  // "268 Mallard Rd" misses, "268 Mallard Road" hits). The bulk
  // resolver MUST run the same rungs, otherwise bulk callers see
  // resolved=false on addresses the single tool would have caught.
  //
  // These tests are *pinned* — they're a regression fence. If a future
  // change adds a new fallback rung (gis lookup, region inference,
  // etc.) to one resolver but not the other, the parity tests should
  // fail and force the author to either (a) add the rung to both or
  // (b) update the parity tests with a justification.

  it('PARITY (#71): bulk runs the same suffix-expansion rung as single — Mallard Rd → Mallard Road', async () => {
    // Same mock shape as get-by-address.test.ts' #43 regression: first
    // attempt with "Rd" returns empty Addresses, second with "Road"
    // returns the home. If bulk skips suffix expansion, it will only
    // make ONE call and degrade to resolved=false.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      const query = decodeURIComponent(
        (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
      );
      if (query.includes('Mallard Road')) {
        return {
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
                    id: '12345',
                  },
                ],
              },
            ],
          },
        };
      }
      // "Mallard Rd" (the as-typed form) misses.
      return {
        resultCode: 0,
        payload: { sections: [{ name: 'Addresses', rows: [] }] },
      };
    });

    const r = await harness.callTool('redfin_resolve_addresses', {
      addresses: [
        { street: '268 Mallard Rd', city: 'Lake Lure', state: 'NC', zip: '28746' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      results: Array<{ resolved: boolean; home_id?: string }>;
    }>(r);
    expect(parsed.results[0].resolved).toBe(true);
    expect(parsed.results[0].home_id).toBe('12345');
  });

  it('PARITY (#71): bulk and single partition identically on a mixed batch', async () => {
    // The strongest parity assertion: feed the same set of addresses
    // through both tools (with identical mocked upstream) and demand
    // identical resolved/unresolved partitioning.
    //
    // Set:
    //   A — clean hit on first attempt              → resolved
    //   B — suffix-expansion required (Rd → Road)   → resolved (was the bug)
    //   C — never resolves                          → unresolved
    //
    // Both tools must produce {resolved: A,B, unresolved: C}.
    const { registerGetByAddressTools } = await import(
      '../../src/tools/get-by-address.js'
    );

    const upstream = (path: string) => {
      const query = decodeURIComponent(
        (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
      );
      if (query.includes('158 Raven')) {
        return {
          resultCode: 0,
          payload: {
            sections: [
              {
                name: 'Addresses',
                rows: [
                  {
                    name: '158 Raven Blvd',
                    subName: 'Lake Lure, NC 28746',
                    url: '/NC/Lake-Lure/158-Raven-Blvd-28746/home/111',
                    id: '111',
                  },
                ],
              },
            ],
          },
        };
      }
      if (query.includes('Mallard Road')) {
        return {
          resultCode: 0,
          payload: {
            sections: [
              {
                name: 'Addresses',
                rows: [
                  {
                    name: '268 Mallard Road',
                    subName: 'Lake Lure, NC 28746',
                    url: '/NC/Lake-Lure/268-Mallard-Rd-28746/home/222',
                    id: '222',
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
    };
    mockFetchStingrayJson.mockImplementation(async (path: string) =>
      upstream(path)
    );

    const inputs: Array<{
      street: string;
      city: string;
      state: string;
      zip: string;
    }> = [
      { street: '158 Raven Blvd', city: 'Lake Lure', state: 'NC', zip: '28746' },
      { street: '268 Mallard Rd', city: 'Lake Lure', state: 'NC', zip: '28746' },
      { street: '0 Nowhere Ln', city: 'Nowhere', state: 'NC', zip: '99999' },
    ];

    // 1) Bulk call
    const bulk = await harness.callTool('redfin_resolve_addresses', {
      addresses: inputs,
    });
    const bulkParsed = parseToolResult<{
      results: Array<{ resolved: boolean; home_id?: string }>;
    }>(bulk);

    // 2) N single calls through a parallel harness, same mock client.
    const singleHarness = await createTestHarness((server) =>
      registerGetByAddressTools(server, mockClient)
    );
    const singleResults = [] as Array<{ resolved: boolean; home_id?: string }>;
    for (const a of inputs) {
      const r = await singleHarness.callTool('redfin_get_by_address', {
        address: a.street,
        city: a.city,
        state: a.state,
        zip: a.zip,
      });
      singleResults.push(
        parseToolResult<{ resolved: boolean; home_id?: string }>(r)
      );
    }
    await singleHarness.close();

    // Partition signature: [resolved, home_id?] per row.
    const sig = (
      rows: Array<{ resolved: boolean; home_id?: string }>
    ): string =>
      rows.map((r) => `${r.resolved ? '1' : '0'}:${r.home_id ?? ''}`).join('|');

    expect(sig(bulkParsed.results)).toBe(sig(singleResults));
    // Sanity: the bug case (Mallard Rd → Mallard Road) must actually resolve.
    expect(bulkParsed.results[1].resolved).toBe(true);
    expect(bulkParsed.results[1].home_id).toBe('222');
  });

  // -- PARITY: search-fallback rung (#75) ----------------------------
  //
  // The newest rung — when autocomplete misses everywhere, fall through
  // to a gis search bounded by `{city, state}` and fuzzy-match. Bulk
  // must walk the same rungs as single, otherwise the round-3 corpus
  // (rural/mountain MLS addresses where autocomplete is blind but
  // search has the listing) regresses on the bulk path.

  it('PARITY (#75): bulk runs the same search-fallback rung as single — autocomplete misses, gis hit picked up', async () => {
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

    const r = await harness.callTool('redfin_resolve_addresses', {
      addresses: [
        {
          street: '212 Ridgeway Rd',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      results: Array<{
        resolved: boolean;
        home_id?: string;
        matched_via?: string;
      }>;
    }>(r);
    expect(parsed.results[0].resolved).toBe(true);
    expect(parsed.results[0].home_id).toBe('99001');
    expect(parsed.results[0].matched_via).toBe('search_fallback');
  });

  it('PERF: a same-city batch does ONE region lookup + ONE gis pull, not N', async () => {
    // Two rows in the same locality, both missing autocomplete and
    // falling through to the search-fallback rung. The batch shares a
    // pool cache, so the expensive region resolve + ~350-home gis pull
    // each fire exactly once regardless of row count.
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
                propertyId: 1,
                url: '/NC/Lake-Lure/100-Oakwood-Dr-28746/home/1',
                streetLine: { value: '100 Oakwood Dr' },
                city: 'Lake Lure',
                state: 'NC',
                zip: '28746',
              },
              {
                propertyId: 2,
                url: '/NC/Lake-Lure/231-Bluebird-Rd-28746/home/2',
                streetLine: { value: '231 Bluebird Rd' },
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

    const r = await harness.callTool('redfin_resolve_addresses', {
      addresses: [
        { street: '100 Oakwood Dr', city: 'Lake Lure', state: 'NC', zip: '28746' },
        { street: '231 Bluebird Rd', city: 'Lake Lure', state: 'NC', zip: '28746' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      results: Array<{ resolved: boolean; home_id?: string }>;
    }>(r);
    expect(parsed.results.map((x) => x.home_id)).toEqual(['1', '2']);

    const calls = mockFetchStingrayJson.mock.calls.map((c) => c[0] as string);
    const gisCalls = calls.filter((p) => p.startsWith('/stingray/api/gis'));
    const regionCalls = calls.filter((p) => {
      if (!p.startsWith('/stingray/do/location-autocomplete')) return false;
      const q = decodeURIComponent(
        (/location=([^&]+)/.exec(p)?.[1] ?? '').replace(/\+/g, ' ')
      );
      return q === 'Lake Lure NC';
    });
    expect(gisCalls).toHaveLength(1);
    expect(regionCalls).toHaveLength(1);
  });
});
