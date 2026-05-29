import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  FetchproxyTimeoutError,
  FetchproxyBridgeDownError,
  FetchproxyProtocolError,
} from '@fetchproxy/server';
import type { RedfinClient } from '../../src/client.js';
import { registerBulkGetTools } from '../../src/tools/bulk-get.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchStingrayJson = vi.fn();
const mockResolveCanonicalUrl = vi.fn();
const mockClient = {
  fetchStingrayJson: mockFetchStingrayJson,
  resolveCanonicalUrl: mockResolveCanonicalUrl,
} as unknown as RedfinClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

// `mapWithConcurrency` lives in `@fetchproxy/server` (0.9.x+) and is
// unit-tested there. We only test redfin-side tool behaviors here.

describe('redfin_bulk_get tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerBulkGetTools(server, mockClient)
    );
  });

  it('fetches every target and captures per-row errors', async () => {
    // ATF for all targets returns a payload, except target 2's ATF
    // throws so that row gets an error.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      const m = /propertyId=(\d+)/.exec(path);
      const pid = m ? parseInt(m[1], 10) : 0;
      if (path.includes('aboveTheFold') && pid === 2) {
        throw new Error('boom');
      }
      if (path.includes('aboveTheFold')) {
        return {
          resultCode: 0,
          payload: {
            addressSectionInfo: {
              streetAddress: `${pid} Main St`,
              city: 'X',
              state: 'NC',
              zip: '28746',
              latestPriceInfo: { amount: pid * 100_000 },
            },
          },
        };
      }
      // BTF
      return {
        resultCode: 0,
        payload: {},
      };
    });
    const r = await harness.callTool('redfin_bulk_get', {
      targets: [
        { property_id: 1, listing_id: 10 },
        { property_id: 2, listing_id: 20 },
        { property_id: 3, listing_id: 30 },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      ok: number;
      errored: number;
      results: Array<{
        error?: string;
        status?: string;
        retryable?: boolean;
        property?: { price: number };
      }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.ok).toBe(2);
    expect(parsed.errored).toBe(1);
    expect(parsed.results[0].property?.price).toBe(100_000);
    expect(parsed.results[1].error).toMatch(/boom/);
    // A plain Error (not a fetchproxy typed error) is a genuine-miss-style
    // outcome: classified as 'other', not retryable.
    expect(parsed.results[1].status).toBe('other');
    expect(parsed.results[1].retryable).toBe(false);
    expect(parsed.results[2].property?.price).toBe(300_000);
  });

  it('classifies a bridge timeout row as status=timeout, retryable=true (#78)', async () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.includes('aboveTheFold')) {
        throw new FetchproxyTimeoutError({
          url: 'https://www.redfin.com/stingray/api/home/details/aboveTheFold',
          timeoutMs: 30_000,
        });
      }
      return { resultCode: 0, payload: {} };
    });
    const r = await harness.callTool('redfin_bulk_get', {
      targets: [{ property_id: 1, listing_id: 10 }],
    });
    const parsed = parseToolResult<{
      ok: number;
      errored: number;
      results: Array<{ error?: string; status?: string; retryable?: boolean }>;
    }>(r);
    expect(parsed.ok).toBe(0);
    expect(parsed.errored).toBe(1);
    expect(parsed.results[0].status).toBe('timeout');
    expect(parsed.results[0].retryable).toBe(true);
    // The standardized cohort wrapper string — must stay distinguishable
    // from "no listing found".
    expect(parsed.results[0].error).toMatch(/bridge timeout after retry/);
  });

  it('classifies a bridge-down row as status=bridge_down, retryable=true (#78)', async () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.includes('aboveTheFold')) {
        throw new FetchproxyBridgeDownError({
          originalError: 'content_script_unreachable',
          retryAttempted: true,
        });
      }
      return { resultCode: 0, payload: {} };
    });
    const r = await harness.callTool('redfin_bulk_get', {
      targets: [{ property_id: 1, listing_id: 10 }],
    });
    const parsed = parseToolResult<{
      ok: number;
      errored: number;
      results: Array<{ error?: string; status?: string; retryable?: boolean }>;
    }>(r);
    expect(parsed.ok).toBe(0);
    expect(parsed.errored).toBe(1);
    expect(parsed.results[0].status).toBe('bridge_down');
    expect(parsed.results[0].retryable).toBe(true);
    expect(parsed.results[0].error).toMatch(/bridge unreachable/);
  });

  it('classifies a protocol-error row as status=protocol, retryable=false (#78)', async () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.includes('aboveTheFold')) {
        throw new FetchproxyProtocolError('no_tab: no signed-in redfin.com tab');
      }
      return { resultCode: 0, payload: {} };
    });
    const r = await harness.callTool('redfin_bulk_get', {
      targets: [{ property_id: 1, listing_id: 10 }],
    });
    const parsed = parseToolResult<{
      ok: number;
      errored: number;
      results: Array<{ error?: string; status?: string; retryable?: boolean }>;
    }>(r);
    expect(parsed.ok).toBe(0);
    expect(parsed.errored).toBe(1);
    expect(parsed.results[0].status).toBe('protocol');
    expect(parsed.results[0].retryable).toBe(false);
    // protocol -> bare message, no wrapper prefix.
    expect(parsed.results[0].error).toBe('no_tab: no signed-in redfin.com tab');
  });

  it('tags successful rows with status=ok (#78)', async () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.includes('aboveTheFold')) {
        return {
          resultCode: 0,
          payload: {
            addressSectionInfo: {
              streetAddress: '1 Main St',
              city: 'X',
              state: 'NC',
              zip: '28746',
              latestPriceInfo: { amount: 100_000 },
            },
          },
        };
      }
      return { resultCode: 0, payload: {} };
    });
    const r = await harness.callTool('redfin_bulk_get', {
      targets: [{ property_id: 1, listing_id: 10 }],
    });
    const parsed = parseToolResult<{
      ok: number;
      results: Array<{ status?: string; retryable?: boolean; error?: string }>;
    }>(r);
    expect(parsed.ok).toBe(1);
    expect(parsed.results[0].status).toBe('ok');
    expect(parsed.results[0].error).toBeUndefined();
    expect(parsed.results[0].retryable).toBeUndefined();
  });

  it('threads lotSqFt from the BTF payload into lot_size + lot_size_acres (#83 review)', async () => {
    // The bulk-get path pulls lotSqFt from belowTheFold.publicRecordsInfo
    // .basicInfo, parallel to taxesDue. Pin that wiring directly here —
    // properties.test.ts covers format() in isolation, but the bulk row
    // assembly was previously untested for these two fields.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      const m = /propertyId=(\d+)/.exec(path);
      const pid = m ? parseInt(m[1], 10) : 0;
      if (path.includes('aboveTheFold')) {
        return {
          resultCode: 0,
          payload: {
            addressSectionInfo: {
              streetAddress: `${pid} Main St`,
              city: 'Lake Lure',
              state: 'NC',
              zip: '28746',
              latestPriceInfo: { amount: 599_000 },
            },
          },
        };
      }
      // BTF: SFH (pid 1) carries a lot; condo (pid 2) has no lotSqFt key.
      return {
        resultCode: 0,
        payload:
          pid === 1
            ? { publicRecordsInfo: { basicInfo: { lotSqFt: 45_738 } } }
            : { publicRecordsInfo: { basicInfo: {} } },
      };
    });
    const r = await harness.callTool('redfin_bulk_get', {
      targets: [
        { property_id: 1, listing_id: 10 },
        { property_id: 2, listing_id: 20 },
      ],
    });
    const parsed = parseToolResult<{
      results: Array<{
        property?: { lot_size?: number | null; lot_size_acres?: number | null };
      }>;
    }>(r);
    // SFH: 45738 sq ft -> 1.05 acres.
    expect(parsed.results[0].property?.lot_size).toBe(45_738);
    expect(parsed.results[0].property?.lot_size_acres).toBe(1.05);
    // Condo: absent lotSqFt -> both null, never 0.
    expect(parsed.results[1].property?.lot_size ?? null).toBeNull();
    expect(parsed.results[1].property?.lot_size_acres ?? null).toBeNull();
  });

  it('resolves a target from property_id alone via redirect + initialInfo (#89)', async () => {
    mockResolveCanonicalUrl.mockResolvedValue(
      'https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/777'
    );
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.includes('initialInfo')) {
        return { resultCode: 0, payload: { propertyId: 777, listingId: 888 } };
      }
      if (path.includes('aboveTheFold')) {
        return {
          resultCode: 0,
          payload: {
            addressSectionInfo: {
              streetAddress: '268 Mallard Rd',
              city: 'Lake Lure',
              state: 'NC',
              zip: '28746',
              latestPriceInfo: { amount: 599_000 },
            },
          },
        };
      }
      // BTF
      return { resultCode: 0, payload: {} };
    });
    const r = await harness.callTool('redfin_bulk_get', {
      targets: [{ property_id: 777 }],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      ok: number;
      errored: number;
      results: Array<{
        error?: string;
        property_id?: number;
        url: string;
        property?: { price: number; listing_id: number };
      }>;
    }>(r);
    expect(mockResolveCanonicalUrl).toHaveBeenCalledWith(777);
    expect(parsed.ok).toBe(1);
    expect(parsed.errored).toBe(0);
    expect(parsed.results[0].property?.price).toBe(599_000);
    expect(parsed.results[0].property?.listing_id).toBe(888);
    expect(parsed.results[0].url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/777'
    );
  });

  it('captures a per-row error when property_id alone cannot be resolved (#89)', async () => {
    mockResolveCanonicalUrl.mockRejectedValue(
      new Error('Redfin property_id 999 could not be resolved from its id alone')
    );
    const r = await harness.callTool('redfin_bulk_get', {
      targets: [{ property_id: 999 }],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      ok: number;
      errored: number;
      results: Array<{
        error?: string;
        property_id?: number;
        status?: string;
        retryable?: boolean;
      }>;
    }>(r);
    expect(parsed.ok).toBe(0);
    expect(parsed.errored).toBe(1);
    expect(parsed.results[0].property_id).toBe(999);
    expect(parsed.results[0].error).toMatch(/could not be resolved/);
    // Genuine miss preserved: a plain resolution failure is 'other' and
    // NOT retryable — must never be confused with a transient timeout.
    expect(parsed.results[0].status).toBe('other');
    expect(parsed.results[0].retryable).toBe(false);
  });

  it('caps targets at 200', async () => {
    const r = await harness.callTool('redfin_bulk_get', {
      targets: Array.from({ length: 201 }, (_, i) => ({
        property_id: i + 1,
        listing_id: 999,
      })),
    });
    expect(r.isError).toBeTruthy();
  });

  it('rejects empty targets array', async () => {
    const r = await harness.callTool('redfin_bulk_get', { targets: [] });
    expect(r.isError).toBeTruthy();
  });
});
