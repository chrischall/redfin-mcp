import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import {
  formatPriceEvent,
  formatTaxEvent,
  registerHistoryTools,
} from '../../src/tools/history.js';
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

describe('formatPriceEvent', () => {
  it('extracts a price-history entry into a clean shape', () => {
    expect(
      formatPriceEvent({
        eventDescription: 'Listed',
        eventDate: Date.parse('2024-05-15'),
        price: { amount: 850000 },
        daysOnMarket: 12,
        source: 'NYSE-MLS',
        sourceId: '12345',
      })
    ).toEqual({
      date: '2024-05-15',
      event: 'Listed',
      price: 850000,
      days_on_market: 12,
      source: 'NYSE-MLS',
      source_id: '12345',
    });
  });

  it('leaves date undefined when eventDate is absent', () => {
    expect(formatPriceEvent({ eventDescription: 'X' }).date).toBeUndefined();
  });
});

describe('formatTaxEvent', () => {
  it('sums land + improvement for total assessed value', () => {
    expect(
      formatTaxEvent({
        rollYear: 2024,
        taxesPaid: 12000,
        taxableLandValue: 300000,
        taxableImprovementValue: 550000,
      })
    ).toEqual({
      year: 2024,
      taxes_paid: 12000,
      land_value: 300000,
      improvement_value: 550000,
      total_assessed_value: 850000,
    });
  });

  it('returns total_assessed_value undefined when both components missing', () => {
    expect(formatTaxEvent({ rollYear: 2020, taxesPaid: 5000 }).total_assessed_value).toBeUndefined();
  });
});

describe('redfin_get_price_history tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerHistoryTools(server, mockClient)
    );
  });

  it('resolves IDs via initialInfo + calls belowTheFold (URL form)', async () => {
    mockFetchStingrayJson
      // initialInfo
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { propertyId: 42, listingId: 100 },
      })
      // belowTheFold
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: {
          propertyHistoryInfo: {
            events: [
              {
                eventDescription: 'Listed',
                eventDate: Date.parse('2024-01-01'),
                price: { amount: 500_000 },
              },
              {
                eventDescription: 'Sold',
                eventDate: Date.parse('2020-06-01'),
                price: { amount: 380_000 },
              },
            ],
          },
          publicRecordsInfo: {
            taxHistory: [
              { rollYear: 2024, taxesPaid: 9000, taxableLandValue: 200_000, taxableImprovementValue: 350_000 },
            ],
          },
        },
      });

    const r = await harness.callTool('redfin_get_price_history', {
      url: '/NY/X/1-Main/home/42',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      price_events: Array<{ price: number }>;
      tax_events: Array<{ year: number }>;
    }>(r);
    expect(parsed.price_events.map((e) => e.price)).toEqual([500_000, 380_000]);
    expect(parsed.tax_events[0].year).toBe(2024);
  });

  it('skips initialInfo when property_id+listing_id are provided', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {},
    });
    await harness.callTool('redfin_get_price_history', {
      property_id: 99,
      listing_id: 999,
    });
    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(1);
    expect(mockFetchStingrayJson.mock.calls[0][0]).toMatch(/belowTheFold/);
  });
});
