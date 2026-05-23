import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import { registerMarketTools } from '../../src/tools/market.js';
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

/** Sampled from a real Brooklyn home-values page 2026-05-23 */
const FIXTURE_OFFER_INSIGHTS = {
  medianListPrice: '$940K',
  medianSalePerList: '98.1%',
  medianListPerSqFt: '$732',
  avgNumOffers: '2',
  medianSalePrice: '$870K',
  avgDownPayment: '15.3%',
  medianSalePerSqFt: '$609',
  numHomesSold: '2269',
  numHomesOnMarket: '18033',
  avgDaysOnMarket: '70',
  yoySalePrice: '+2.4%',
  yoySalePerSqft: '-8.3%',
};

describe('redfin_get_market_report tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerMarketTools(server, mockClient)
    );
  });

  it('with region_id+region_type: hits offer-insights directly', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: FIXTURE_OFFER_INSIGHTS,
    });

    const result = await harness.callTool('redfin_get_market_report', {
      region_id: 30749,
      region_type: 6,
    });
    expect(result.isError).toBeFalsy();
    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(1);
    expect(mockFetchStingrayJson.mock.calls[0][0]).toBe(
      '/stingray/api/region/6/30749/1/offer-insights'
    );
    const parsed = parseToolResult<{
      region: { region_id: number };
      property_type: number;
      metrics: typeof FIXTURE_OFFER_INSIGHTS;
    }>(result);
    expect(parsed.region.region_id).toBe(30749);
    expect(parsed.property_type).toBe(1);
    expect(parsed.metrics.medianSalePrice).toBe('$870K');
    expect(parsed.metrics.yoySalePrice).toBe('+2.4%');
  });

  it('honors property_type override', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: FIXTURE_OFFER_INSIGHTS,
    });
    await harness.callTool('redfin_get_market_report', {
      region_id: 30749,
      region_type: 6,
      property_type: 3,
    });
    expect(mockFetchStingrayJson.mock.calls[0][0]).toBe(
      '/stingray/api/region/6/30749/3/offer-insights'
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
              rows: [{ id: '6_30749', name: 'New York', url: '/x' }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: FIXTURE_OFFER_INSIGHTS,
      });
    const result = await harness.callTool('redfin_get_market_report', {
      location: 'Brooklyn',
    });
    expect(result.isError).toBeFalsy();
    expect(mockFetchStingrayJson.mock.calls[0][0]).toMatch(
      /location-autocomplete/
    );
    expect(mockFetchStingrayJson.mock.calls[1][0]).toBe(
      '/stingray/api/region/6/30749/1/offer-insights'
    );
    const parsed = parseToolResult<{ region: { name?: string } }>(result);
    expect(parsed.region.name).toBe('New York');
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
