import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import {
  formatPriceEvent,
  formatTaxEvent,
  mapEventType,
  normalizeEvents,
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
        price: 850000,
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

  it('leaves price undefined when the event has no numeric price', () => {
    // Admin-only or private-listing events arrive without a price.
    expect(
      formatPriceEvent({
        eventDescription: 'Listed',
        eventDate: Date.parse('2024-01-01'),
      }).price
    ).toBeUndefined();
  });
});

describe('formatTaxEvent', () => {
  it('sums land + improvement for total assessed value', () => {
    // Field name is `taxesDue` in the live API, even though our public
    // shape calls it `taxes_paid` (Redfin's UI labels it "taxes" plain).
    expect(
      formatTaxEvent({
        rollYear: 2024,
        taxesDue: 12000,
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
    expect(formatTaxEvent({ rollYear: 2020, taxesDue: 5000 }).total_assessed_value).toBeUndefined();
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
                price: 500_000,
              },
              {
                eventDescription: 'Sold',
                eventDate: Date.parse('2020-06-01'),
                price: 380_000,
              },
            ],
          },
          publicRecordsInfo: {
            allTaxInfo: [
              { rollYear: 2024, taxesDue: 9000, taxableLandValue: 200_000, taxableImprovementValue: 350_000 },
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

  it('skips initialInfo when property_id+listing_id are provided (fetches BTF + ATF in parallel for canonical URL)', async () => {
    mockFetchStingrayJson.mockResolvedValue({
      resultCode: 0,
      payload: {},
    });
    await harness.callTool('redfin_get_price_history', {
      property_id: 99,
      listing_id: 999,
    });
    const paths = mockFetchStingrayJson.mock.calls.map((c) => c[0] as string);
    expect(paths.some((p) => /belowTheFold/.test(p))).toBe(true);
    expect(paths.some((p) => /aboveTheFold/.test(p))).toBe(true);
    expect(paths.every((p) => !/initialInfo/.test(p))).toBe(true);
  });

  it('returns canonical URL when called with IDs and ATF provides address', async () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (/aboveTheFold/.test(path)) {
        return {
          resultCode: 0,
          payload: {
            addressSectionInfo: {
              streetAddress: '268 Mallard Rd',
              city: 'Lake Lure',
              state: 'NC',
              zip: '28746',
            },
          },
        };
      }
      return { resultCode: 0, payload: {} };
    });
    const r = await harness.callTool('redfin_get_price_history', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{ url: string }>(r);
    expect(parsed.url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345'
    );
  });

  it('skips parallel ATF when URL was provided (canonical URL already known)', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { propertyId: 1, listingId: 2 },
      })
      .mockResolvedValueOnce({ resultCode: 0, payload: {} });
    await harness.callTool('redfin_get_price_history', {
      url: '/NY/Brooklyn/foo/home/1',
    });
    const paths = mockFetchStingrayJson.mock.calls.map((c) => c[0] as string);
    expect(paths.some((p) => /aboveTheFold/.test(p))).toBe(false);
  });

  it('falls back to /home/<id> short form when parallel ATF errors (does not break price-history)', async () => {
    // The ATF fetch is best-effort — its only job is to provide an
    // addressSectionInfo for canonical-URL upgrading. A transient ATF
    // error must not surface to the caller; price-history still works
    // and the URL gracefully degrades to the short form.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (/aboveTheFold/.test(path)) {
        throw new Error('ATF transient failure');
      }
      // BTF: valid response with one price event so we can assert the
      // tool returned a real result, not just an error.
      return {
        resultCode: 0,
        payload: {
          propertyHistoryInfo: {
            events: [{ eventDescription: 'Listed', price: 1, eventDate: 1 }],
          },
        },
      };
    });
    const r = await harness.callTool('redfin_get_price_history', {
      property_id: 42,
      listing_id: 99,
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{ url: string; price_events: unknown[] }>(r);
    expect(parsed.url).toBe('https://www.redfin.com/home/42');
    expect(parsed.price_events.length).toBe(1);
  });

  it('surfaces events_normalized alongside price_events (#48)', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        // BTF
        resultCode: 0,
        payload: {
          propertyHistoryInfo: {
            events: [
              {
                eventDescription: 'Listed',
                eventDate: Date.parse('2024-01-01'),
                price: 500_000,
              },
              {
                eventDescription: 'Price Changed',
                eventDate: Date.parse('2024-02-01'),
                price: 480_000,
              },
              {
                eventDescription: 'Sold (MLS)',
                eventDate: Date.parse('2024-03-01'),
                price: 475_000,
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        // ATF (parallel)
        resultCode: 0,
        payload: {
          addressSectionInfo: {
            streetAddress: '1 Main St',
            city: 'X',
            state: 'NY',
            zip: '11111',
          },
        },
      });
    const r = await harness.callTool('redfin_get_price_history', {
      property_id: 12345,
      listing_id: 99,
    });
    const parsed = parseToolResult<{
      events_normalized: Array<{
        type: string;
        price?: number;
        price_change_pct?: number;
      }>;
    }>(r);
    expect(parsed.events_normalized).toHaveLength(3);
    expect(parsed.events_normalized[0].type).toBe('Listed');
    expect(parsed.events_normalized[1].type).toBe('PriceChange');
    expect(parsed.events_normalized[2].type).toBe('Sold');
    // (480k - 500k) / 500k * 100 = -4.0
    expect(parsed.events_normalized[1].price_change_pct).toBe(-4.0);
  });
});

describe('mapEventType (#48 shared enum)', () => {
  it('maps Redfin event strings to the shared enum', () => {
    expect(mapEventType('Listed')).toBe('Listed');
    expect(mapEventType('Relisted')).toBe('Relisted');
    expect(mapEventType('Price Change')).toBe('PriceChange');
    expect(mapEventType('Price Reduction')).toBe('PriceChange');
    expect(mapEventType('Pending')).toBe('Pending');
    expect(mapEventType('Contingent')).toBe('Contingent');
    expect(mapEventType('Sold (MLS)')).toBe('Sold');
    expect(mapEventType('Sold (Public Records)')).toBe('Sold');
    expect(mapEventType('Withdrawn')).toBe('Withdrawn');
    expect(mapEventType('Delisted')).toBe('Delisted');
  });

  it('is case-insensitive', () => {
    expect(mapEventType('SOLD')).toBe('Sold');
    expect(mapEventType('listed')).toBe('Listed');
  });

  it('PIN: "Relisted" does NOT match as "Listed" (substring-style)', () => {
    expect(mapEventType('Relisted')).toBe('Relisted');
  });

  it('returns "Unknown" for unmapped strings', () => {
    expect(mapEventType('Mystery event')).toBe('Unknown');
    expect(mapEventType(undefined)).toBe('Unknown');
  });
});

describe('normalizeEvents (#48 cross-MCP shape)', () => {
  it('sorts oldest-first and computes price_change_pct against the prior priced event', () => {
    const out = normalizeEvents([
      {
        eventDescription: 'Sold (MLS)',
        eventDate: Date.parse('2024-03-01'),
        price: 475_000,
      },
      {
        eventDescription: 'Listed',
        eventDate: Date.parse('2024-01-01'),
        price: 500_000,
      },
      {
        eventDescription: 'Price Change',
        eventDate: Date.parse('2024-02-01'),
        price: 480_000,
      },
    ]);
    expect(out.map((e) => e.type)).toEqual(['Listed', 'PriceChange', 'Sold']);
    expect(out[0].price_change_pct).toBeUndefined(); // first event has no prior
    expect(out[1].price_change_pct).toBe(-4.0);
    expect(out[2].price_change_pct).toBeCloseTo(-1.04, 1);
  });

  it('preserves raw_event so callers can keep Redfin\'s verbatim labels', () => {
    const out = normalizeEvents([
      { eventDescription: 'Sold (Public Records)', eventDate: 1, price: 1 },
    ]);
    expect(out[0].raw_event).toBe('Sold (Public Records)');
    expect(out[0].type).toBe('Sold');
  });
});
