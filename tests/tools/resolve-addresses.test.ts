import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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
});
