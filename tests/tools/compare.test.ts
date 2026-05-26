import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import { buildSummary, registerCompareTools } from '../../src/tools/compare.js';
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

describe('buildSummary', () => {
  it('aligns per-field values across rows + null-fills errors', () => {
    const rows = [
      {
        property_id: 1,
        url: 'u',
        property: { property_id: 1, url: 'u', price: 100, beds: 2, baths: 1 },
      },
      { property_id: 2, url: 'u', error: 'fetch failed' },
      {
        property_id: 3,
        url: 'u',
        property: { property_id: 3, url: 'u', price: 300, beds: 4, baths: 3 },
      },
    ];
    const summary = buildSummary(rows as never);
    const price = summary.find((r) => r.field === 'price')!;
    expect(price.values).toEqual([100, null, 300]);
    const beds = summary.find((r) => r.field === 'beds')!;
    expect(beds.values).toEqual([2, null, 4]);
  });
});

describe('redfin_compare_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerCompareTools(server, mockClient)
    );
  });

  it('runs concurrent fetches per target and aligns the summary', async () => {
    // Each target with property_id+listing_id skips initialInfo and just calls aboveTheFold once.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      const m = /propertyId=(\d+)/.exec(path);
      const pid = m ? parseInt(m[1], 10) : 0;
      return {
        resultCode: 0,
        payload: {
          addressSectionInfo: {
            streetAddress: `${pid} Main`,
            city: 'X',
            state: 'NY',
            zip: '11111',
            beds: pid,
            baths: pid,
            latestPriceInfo: { amount: pid * 100_000 },
          },
        },
      };
    });

    const r = await harness.callTool('redfin_compare_properties', {
      targets: [
        { property_id: 1, listing_id: 100 },
        { property_id: 2, listing_id: 200 },
        { property_id: 3, listing_id: 300 },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      summary: Array<{ field: string; values: unknown[] }>;
      results: Array<{ property?: { price: number } }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.results.map((res) => res.property?.price)).toEqual([
      100_000, 200_000, 300_000,
    ]);
  });

  it('returns canonical URLs when targets are IDs-only and ATF gives address', async () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      const m = /propertyId=(\d+)/.exec(path);
      const pid = m ? parseInt(m[1], 10) : 0;
      return {
        resultCode: 0,
        payload: {
          addressSectionInfo: {
            streetAddress: `${pid} Main St`,
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
        },
      };
    });
    const r = await harness.callTool('redfin_compare_properties', {
      targets: [
        { property_id: 1, listing_id: 10 },
        { property_id: 2, listing_id: 20 },
      ],
    });
    const parsed = parseToolResult<{ results: Array<{ url: string }> }>(r);
    expect(parsed.results.map((x) => x.url)).toEqual([
      'https://www.redfin.com/NC/Lake-Lure/1-Main-St-28746/home/1',
      'https://www.redfin.com/NC/Lake-Lure/2-Main-St-28746/home/2',
    ]);
  });

  it('captures per-target errors without failing the whole call', async () => {
    let n = 0;
    mockFetchStingrayJson.mockImplementation(async () => {
      n++;
      if (n === 2) throw new Error('boom');
      return {
        resultCode: 0,
        payload: {
          addressSectionInfo: {
            streetAddress: 'x',
            city: 'X',
            state: 'NY',
            zip: '11111',
            latestPriceInfo: { amount: 500 },
          },
        },
      };
    });
    const r = await harness.callTool('redfin_compare_properties', {
      targets: [
        { property_id: 1, listing_id: 10 },
        { property_id: 2, listing_id: 20 },
        { property_id: 3, listing_id: 30 },
      ],
    });
    const parsed = parseToolResult<{
      results: Array<{ error?: string; property?: { price: number } }>;
    }>(r);
    expect(parsed.results[0].property?.price).toBe(500);
    expect(parsed.results[1].error).toMatch(/boom/);
    expect(parsed.results[2].property?.price).toBe(500);
  });
});
