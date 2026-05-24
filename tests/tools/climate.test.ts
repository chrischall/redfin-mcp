import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import {
  extractClimateBlock,
  formatClimate,
  registerClimateTools,
} from '../../src/tools/climate.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as RedfinClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('extractClimateBlock', () => {
  it('extracts a plain (unescaped) embedded JSON block', () => {
    const html = 'before "floodData":{"fsid":42,"floodFactor":3} after';
    expect(extractClimateBlock(html, 'floodData')).toEqual({
      fsid: 42,
      floodFactor: 3,
    });
  });

  it('extracts a backslash-escaped block as Redfin serializes it', () => {
    // Simulates the RSC stream encoding: `\"fireData\":{\"fsid\":7,\"fireFactor\":5}`
    const html =
      'noise \\"fireData\\":{\\"fsid\\":7,\\"fireFactor\\":5,\\"riskDirection\\":\\"stationary\\"} more';
    const out = extractClimateBlock(html, 'fireData');
    expect(out).toEqual({
      fsid: 7,
      fireFactor: 5,
      riskDirection: 'stationary',
    });
  });

  it('returns null when the key is not in the HTML', () => {
    expect(extractClimateBlock('<html></html>', 'floodData')).toBeNull();
  });

  it('handles nested objects + arrays in the climate blob', () => {
    const html =
      'before "heatData":{"fsid":1,"heatFactor":7,"history":[{"y":2020,"v":5},{"y":2024,"v":7}]} end';
    const out = extractClimateBlock(html, 'heatData') as Record<string, unknown>;
    expect(out.heatFactor).toBe(7);
    expect(out.history).toEqual([
      { y: 2020, v: 5 },
      { y: 2024, v: 7 },
    ]);
  });
});

describe('formatClimate', () => {
  it('flattens the three factors with safe fallbacks', () => {
    const out = formatClimate(
      {
        fsid: 100,
        floodFactor: 2,
        femaZones: ['X (unshaded)'],
        riskDirection: 1,
        chance: [
          { year: 2024, threshold: '0', mid: 0.01 },
          { year: 2034, threshold: '0', mid: 0.02 },
        ],
      },
      {
        fsid: 100,
        fireFactor: 5,
        riskDirection: 'increasing',
        relativeRisk: 0.42,
        lowInsurancePrice: 800,
        highInsurancePrice: 1500,
        numberOfProviders: 6,
      },
      {
        fsid: 100,
        heatFactor: 7,
        riskDirection: 'increasing',
        cumulativeRiskYear0: 7,
        cumulativeRiskYear20: 12,
      }
    );
    expect(out.fsid).toBe(100);
    expect(out.flood?.flood_factor).toBe(2);
    expect(out.flood?.annual_chance_30yr?.[0]).toEqual({
      year: 2024,
      threshold: '0',
      chance_pct: 0.01,
    });
    expect(out.fire?.fire_factor).toBe(5);
    expect(out.heat?.heat_factor).toBe(7);
    expect(out.heat?.cumulative_risk_year20).toBe(12);
  });

  it('omits factor objects when their primary score is missing', () => {
    const out = formatClimate(null, null, null);
    expect(out.flood).toBeUndefined();
    expect(out.fire).toBeUndefined();
    expect(out.heat).toBeUndefined();
  });
});

describe('redfin_get_climate_risk tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerClimateTools(server, mockClient)
    );
  });

  it('fetches HTML and returns the three risk factors', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      'a "floodData":{"fsid":1,"floodFactor":2} b "fireData":{"fsid":1,"fireFactor":3} c "heatData":{"fsid":1,"heatFactor":4}'
    );
    const r = await harness.callTool('redfin_get_climate_risk', {
      url: '/NY/Brooklyn/foo/home/42',
    });
    const parsed = parseToolResult<{
      fsid: number;
      flood: { flood_factor: number };
      fire: { fire_factor: number };
      heat: { heat_factor: number };
    }>(r);
    expect(parsed.fsid).toBe(1);
    expect(parsed.flood.flood_factor).toBe(2);
    expect(parsed.fire.fire_factor).toBe(3);
    expect(parsed.heat.heat_factor).toBe(4);
  });

  it('returns an empty report when the page has no climate data', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no climate data here</html>');
    const r = await harness.callTool('redfin_get_climate_risk', {
      url: '/x',
    });
    const parsed = parseToolResult<{ flood?: unknown; fire?: unknown; heat?: unknown; url: string }>(r);
    expect(parsed.flood).toBeUndefined();
    expect(parsed.fire).toBeUndefined();
    expect(parsed.heat).toBeUndefined();
    expect(parsed.url).toContain('redfin.com');
  });
});
