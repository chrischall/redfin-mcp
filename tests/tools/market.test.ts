import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import { formatMetric, registerMarketTools } from '../../src/tools/market.js';
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

/** Sampled from a real /stingray/api/region/2/16163/1/market-trends call. */
const FIXTURE_MARKET_TRENDS = {
  tableData: {
    homesForSaleCurMonth: 'April 2026',
    homesSoldCurMonth: 'April 2026',
    homesForSale: [
      {
        label: '# Homes for Sale',
        valueType: 'LONG',
        currentHouseAndCondoValue: 147,
        houseAndCondoYoyUp: true,
        houseAndCondoYoyValueProportionalChange: 0.256,
        houseAndCondoMomUp: false,
        houseAndCondoMomValueProportionalChange: 0.013,
      },
      {
        label: 'Median list price',
        valueType: 'CURRENCY_THOUSANDS',
        currentHouseAndCondoValue: 87,
        houseAndCondoYoyUp: false,
        houseAndCondoYoyValueProportionalChange: 0.032,
        houseAndCondoMomUp: true,
        houseAndCondoMomValueProportionalChange: 0.024,
      },
    ],
    homesSold: [
      {
        label: 'Median Sold Price',
        valueType: 'CURRENCY_THOUSANDS',
        currentHouseAndCondoValue: 65,
        houseAndCondoYoyUp: false,
        houseAndCondoYoyValueProportionalChange: 0.127,
        houseAndCondoMomUp: false,
        houseAndCondoMomValueProportionalChange: 0.248,
      },
      {
        label: '% Sale to List',
        valueType: 'PERCENT',
        currentHouseAndCondoValue: 0.9278,
        houseAndCondoYoyUp: true,
        houseAndCondoYoyValueProportionalChange: 0.137,
        houseAndCondoMomUp: true,
        houseAndCondoMomValueProportionalChange: 0.018,
      },
    ],
  },
};

describe('formatMetric', () => {
  it('lifts a CURRENCY_THOUSANDS row with both YoY and MoM change', () => {
    const out = formatMetric({
      label: 'Median list price',
      valueType: 'CURRENCY_THOUSANDS',
      currentHouseAndCondoValue: 87,
      houseAndCondoYoyUp: false,
      houseAndCondoYoyValueProportionalChange: 0.032,
      houseAndCondoMomUp: true,
      houseAndCondoMomValueProportionalChange: 0.024,
    });
    expect(out).toEqual({
      label: 'Median list price',
      value: 87,
      unit: 'usd_thousands',
      yoy_change_fraction: 0.032,
      yoy_direction: 'down',
      mom_change_fraction: 0.024,
      mom_direction: 'up',
    });
  });

  it('maps valueType to a stable unit string', () => {
    expect(formatMetric({ valueType: 'LONG', currentHouseAndCondoValue: 1 }).unit).toBe('count');
    expect(formatMetric({ valueType: 'CURRENCY', currentHouseAndCondoValue: 1 }).unit).toBe('usd');
    expect(formatMetric({ valueType: 'PERCENT', currentHouseAndCondoValue: 0.5 }).unit).toBe(
      'percent_fraction'
    );
  });

  it('omits change fields when not present', () => {
    const out = formatMetric({ label: 'X', valueType: 'LONG', currentHouseAndCondoValue: 5 });
    expect(out.yoy_change_fraction).toBeUndefined();
    expect(out.mom_change_fraction).toBeUndefined();
  });
});

describe('redfin_get_market_report tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerMarketTools(server, mockClient)
    );
  });

  it('with region_id+region_type: hits market-trends + returns formatted metrics', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: FIXTURE_MARKET_TRENDS,
    });

    const result = await harness.callTool('redfin_get_market_report', {
      region_id: 30749,
      region_type: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(1);
    expect(mockFetchStingrayJson.mock.calls[0][0]).toBe(
      '/stingray/api/region/2/30749/1/market-trends'
    );
    const parsed = parseToolResult<{
      region: { region_id: number };
      property_type: number;
      for_sale_period: string;
      homes_for_sale: Array<{ label: string; value: number; unit: string }>;
      homes_sold: Array<{ label: string; value: number; unit: string }>;
    }>(result);
    expect(parsed.region.region_id).toBe(30749);
    expect(parsed.property_type).toBe(1);
    expect(parsed.for_sale_period).toBe('April 2026');
    expect(parsed.homes_for_sale.map((m) => m.label)).toEqual([
      '# Homes for Sale',
      'Median list price',
    ]);
    expect(parsed.homes_sold[1]).toEqual({
      label: '% Sale to List',
      value: 0.9278,
      unit: 'percent_fraction',
      yoy_change_fraction: 0.137,
      yoy_direction: 'up',
      mom_change_fraction: 0.018,
      mom_direction: 'up',
    });
  });

  it('honors property_type override', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: FIXTURE_MARKET_TRENDS,
    });
    await harness.callTool('redfin_get_market_report', {
      region_id: 30749,
      region_type: 2,
      property_type: 3,
    });
    expect(mockFetchStingrayJson.mock.calls[0][0]).toBe(
      '/stingray/api/region/2/30749/3/market-trends'
    );
  });

  it('with location: resolves via autocomplete first', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          sections: [
            {
              name: 'Places',
              rows: [{ id: '2_30749', name: 'New York', url: '/x' }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: FIXTURE_MARKET_TRENDS,
      });
    const result = await harness.callTool('redfin_get_market_report', {
      location: 'New York',
    });
    expect(result.isError).toBeFalsy();
    expect(mockFetchStingrayJson.mock.calls[0][0]).toMatch(
      /location-autocomplete/
    );
    expect(mockFetchStingrayJson.mock.calls[1][0]).toBe(
      '/stingray/api/region/2/30749/1/market-trends'
    );
    const parsed = parseToolResult<{ region: { name?: string } }>(result);
    expect(parsed.region.name).toBe('New York');
  });

  it('returns empty metric arrays when tableData is missing (some neighborhoods)', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {},
    });
    const result = await harness.callTool('redfin_get_market_report', {
      region_id: 219258,
      region_type: 6,
    });
    const parsed = parseToolResult<{
      homes_for_sale: unknown[];
      homes_sold: unknown[];
    }>(result);
    expect(parsed.homes_for_sale).toEqual([]);
    expect(parsed.homes_sold).toEqual([]);
  });

  it('errors when neither location nor region IDs are provided', async () => {
    const result = await harness.callTool('redfin_get_market_report', {});
    expect(result.isError).toBeTruthy();
  });

  it('errors when location cannot be resolved', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { sections: [{ name: 'Places', rows: [] }] },
    });
    const result = await harness.callTool('redfin_get_market_report', {
      location: 'nonexistent-xyz',
    });
    expect(result.isError).toBeTruthy();
  });
});
