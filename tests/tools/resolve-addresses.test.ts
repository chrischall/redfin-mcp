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
});
