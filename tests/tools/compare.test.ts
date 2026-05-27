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

  it('includes derived fields (hoa_monthly_usd, price_drop_*, last_sold_*, tax_annual)', () => {
    const rows = [
      {
        property_id: 1,
        url: 'u',
        property: {
          property_id: 1,
          url: 'u',
          hoa_monthly_usd: 250,
          price_drop_amount: 20_000,
          price_drop_percent: 4.0,
          last_sold_price: 400_000,
          last_sold_date: '2024-01-15',
          tax_annual: 5400,
        },
      },
    ];
    const summary = buildSummary(rows as never);
    expect(summary.find((r) => r.field === 'hoa_monthly_usd')?.values).toEqual([250]);
    expect(summary.find((r) => r.field === 'price_drop_amount')?.values).toEqual([20_000]);
    expect(summary.find((r) => r.field === 'price_drop_percent')?.values).toEqual([4.0]);
    expect(summary.find((r) => r.field === 'last_sold_price')?.values).toEqual([400_000]);
    expect(summary.find((r) => r.field === 'last_sold_date')?.values).toEqual(['2024-01-15']);
    expect(summary.find((r) => r.field === 'tax_annual')?.values).toEqual([5400]);
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
    // compare now fetches ATF + BTF per target in parallel. Fail the
    // ATF for target 2 (path contains `aboveTheFold` and propertyId=2),
    // let the rest succeed.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.includes('aboveTheFold') && path.includes('propertyId=2')) {
        throw new Error('boom');
      }
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

  it('omits description by default and surfaces extracted_features per record', async () => {
    mockFetchStingrayJson.mockResolvedValue({
      resultCode: 0,
      payload: {
        addressSectionInfo: { streetAddress: 'x', city: 'X', state: 'NY', zip: '11111' },
        mainHouseInfo: {
          publicRemarksParagraph: 'Lakefront with private dock.',
        },
      },
    });
    const r = await harness.callTool('redfin_compare_properties', {
      targets: [
        { property_id: 1, listing_id: 10 },
        { property_id: 2, listing_id: 20 },
      ],
    });
    const parsed = parseToolResult<{
      results: Array<{
        property?: {
          description?: string;
          extracted_features?: { lake_front: boolean; dock: string | null };
        };
      }>;
    }>(r);
    expect(parsed.results[0].property?.description).toBeUndefined();
    expect(parsed.results[0].property?.extracted_features?.lake_front).toBe(true);
    expect(parsed.results[0].property?.extracted_features?.dock).toBe('private');
  });

  it('accepts up to 25 targets (#57 raised cap from 8 → 25)', async () => {
    mockFetchStingrayJson.mockResolvedValue({
      resultCode: 0,
      payload: {
        addressSectionInfo: { streetAddress: 'x', city: 'X', state: 'NY', zip: '11111' },
      },
    });
    const r = await harness.callTool('redfin_compare_properties', {
      targets: Array.from({ length: 25 }, (_, i) => ({
        property_id: i + 1,
        listing_id: 10,
      })),
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{ count: number }>(r);
    expect(parsed.count).toBe(25);
  });

  it('rejects 26 targets (cap is 25)', async () => {
    const r = await harness.callTool('redfin_compare_properties', {
      targets: Array.from({ length: 26 }, (_, i) => ({
        property_id: i + 1,
        listing_id: 10,
      })),
    });
    expect(r.isError).toBeTruthy();
  });

  it('omits the `summary` field by default (#37) — opt in with include_summary=true', async () => {
    mockFetchStingrayJson.mockResolvedValue({
      resultCode: 0,
      payload: {
        addressSectionInfo: {
          streetAddress: 'x', city: 'X', state: 'NY', zip: '11111',
          latestPriceInfo: { amount: 500 },
        },
      },
    });
    const rNoSummary = await harness.callTool('redfin_compare_properties', {
      targets: [
        { property_id: 1, listing_id: 10 },
        { property_id: 2, listing_id: 20 },
      ],
    });
    const parsedNo = parseToolResult<{ summary?: unknown; results: unknown[] }>(
      rNoSummary
    );
    expect(parsedNo.summary).toBeUndefined();
    expect(parsedNo.results).toHaveLength(2);

    const rWithSummary = await harness.callTool('redfin_compare_properties', {
      targets: [
        { property_id: 1, listing_id: 10 },
        { property_id: 2, listing_id: 20 },
      ],
      include_summary: true,
    });
    const parsedYes = parseToolResult<{
      summary?: Array<{ field: string; values: unknown[] }>;
    }>(rWithSummary);
    expect(parsedYes.summary).toBeDefined();
    // Aligned-by-field with 2 rows.
    expect(parsedYes.summary?.find((r) => r.field === 'price')?.values).toEqual([500, 500]);
  });

  it('emits description on every row when include_description=true', async () => {
    mockFetchStingrayJson.mockResolvedValue({
      resultCode: 0,
      payload: {
        addressSectionInfo: { streetAddress: 'x', city: 'X', state: 'NY', zip: '11111' },
        mainHouseInfo: { publicRemarksParagraph: 'Cozy cabin.' },
      },
    });
    const r = await harness.callTool('redfin_compare_properties', {
      targets: [
        { property_id: 1, listing_id: 10 },
        { property_id: 2, listing_id: 20 },
      ],
      include_description: true,
    });
    const parsed = parseToolResult<{
      results: Array<{ property?: { description?: string } }>;
    }>(r);
    expect(parsed.results[0].property?.description).toBe('Cozy cabin.');
    expect(parsed.results[1].property?.description).toBe('Cozy cabin.');
  });
});
