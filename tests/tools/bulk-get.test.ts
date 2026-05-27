import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import {
  mapWithConcurrency,
  registerBulkGetTools,
} from '../../src/tools/bulk-get.js';
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

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('caps in-flight workers at the concurrency limit', async () => {
    let inFlight = 0;
    let max = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(max).toBeLessThanOrEqual(3);
  });

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => null)).toEqual([]);
  });
});

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
      results: Array<{ error?: string; property?: { price: number } }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.ok).toBe(2);
    expect(parsed.errored).toBe(1);
    expect(parsed.results[0].property?.price).toBe(100_000);
    expect(parsed.results[1].error).toMatch(/boom/);
    expect(parsed.results[2].property?.price).toBe(300_000);
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
