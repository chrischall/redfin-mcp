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

  it('returns {available: false, reason} when the page has no climate data (#51)', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no climate data here</html>');
    const r = await harness.callTool('redfin_get_climate_risk', {
      url: '/x',
    });
    const parsed = parseToolResult<{
      available: boolean;
      reason: string;
      not_covered: string[];
      flood?: unknown;
      fire?: unknown;
      heat?: unknown;
      url: string;
    }>(r);
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toBe('no_first_street_data');
    expect(parsed.flood).toBeUndefined();
    expect(parsed.fire).toBeUndefined();
    expect(parsed.heat).toBeUndefined();
    expect(parsed.url).toContain('redfin.com');
    // #54 — landslide gap surfaced on every response.
    expect(parsed.not_covered).toEqual(['landslide']);
  });

  it('returns {available: true, ...} alongside the risk blocks when data IS present (#51)', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      'a "floodData":{"fsid":1,"floodFactor":2} b "fireData":{"fsid":1,"fireFactor":3}'
    );
    const r = await harness.callTool('redfin_get_climate_risk', { url: '/x' });
    const parsed = parseToolResult<{ available: boolean; not_covered: string[] }>(
      r
    );
    expect(parsed.available).toBe(true);
    expect(parsed.not_covered).toEqual(['landslide']);
  });

  it('surfaces cluster_id when the page embeds a census tract (#53)', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      'a "censusTract":"371110304002" b "fireData":{"fsid":1,"fireFactor":3}'
    );
    const r = await harness.callTool('redfin_get_climate_risk', { url: '/x' });
    const parsed = parseToolResult<{ cluster_id?: string }>(r);
    expect(parsed.cluster_id).toBe('371110304002');
  });
});

describe('redfin_get_climate_risk_bulk tool (#52)', () => {
  let bulkHarness: Awaited<ReturnType<typeof createTestHarness>>;
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    if (bulkHarness) await bulkHarness.close();
  });

  it('setup', async () => {
    bulkHarness = await createTestHarness((server) =>
      registerClimateTools(server, mockClient)
    );
  });

  it('fetches all URLs concurrently, preserving order, with per-row error capture', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (path.includes('home/2')) throw new Error('boom');
      if (path.includes('home/3')) {
        return 'no data here';
      }
      return '"fireData":{"fsid":1,"fireFactor":5} "censusTract":"371110304002"';
    });
    const r = await bulkHarness.callTool('redfin_get_climate_risk_bulk', {
      urls: [
        '/NY/X/foo/home/1',
        '/NY/X/foo/home/2',
        '/NY/X/foo/home/3',
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      ok: number;
      unavailable: number;
      errored: number;
      cluster_summary?: Array<{ cluster_id: string; urls: string[] }>;
      results: Array<{
        url: string;
        result?: { available: boolean; cluster_id?: string };
        error?: string;
      }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.ok).toBe(1);
    expect(parsed.errored).toBe(1);
    expect(parsed.unavailable).toBe(1);
    expect(parsed.results[0].result?.cluster_id).toBe('371110304002');
    expect(parsed.results[1].error).toMatch(/boom/);
    expect(parsed.results[2].result?.available).toBe(false);
  });

  it('emits cluster_summary when 2+ properties share a cluster_id', async () => {
    mockFetchHtml.mockResolvedValue(
      '"fireData":{"fsid":1,"fireFactor":3} "censusTract":"371110304002"'
    );
    const r = await bulkHarness.callTool('redfin_get_climate_risk_bulk', {
      urls: ['/x/home/1', '/x/home/2', '/x/home/3'],
    });
    const parsed = parseToolResult<{
      cluster_summary?: Array<{ cluster_id: string; urls: string[] }>;
    }>(r);
    expect(parsed.cluster_summary).toHaveLength(1);
    expect(parsed.cluster_summary?.[0].cluster_id).toBe('371110304002');
    expect(parsed.cluster_summary?.[0].urls).toHaveLength(3);
  });

  it('rejects empty urls array', async () => {
    const r = await bulkHarness.callTool('redfin_get_climate_risk_bulk', {
      urls: [],
    });
    expect(r.isError).toBeTruthy();
  });

  it('caps at 100 urls', async () => {
    const r = await bulkHarness.callTool('redfin_get_climate_risk_bulk', {
      urls: Array.from({ length: 101 }, (_, i) => `/x/home/${i}`),
    });
    expect(r.isError).toBeTruthy();
  });
});

describe('redfin_get_area_climate_baseline tool (#53)', () => {
  let areaHarness: Awaited<ReturnType<typeof createTestHarness>>;
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    if (areaHarness) await areaHarness.close();
  });

  it('setup', async () => {
    areaHarness = await createTestHarness((server) =>
      registerClimateTools(server, mockClient)
    );
  });

  it('averages fire/flood/heat factors across the sample and surfaces shared cluster_id', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      // Each sample has the same cluster_id and similar factors.
      return `"fireData":{"fsid":${n},"fireFactor":${4 + n}} "censusTract":"371110304002"`;
    });
    const r = await areaHarness.callTool('redfin_get_area_climate_baseline', {
      sample_urls: ['/x/home/1', '/x/home/2', '/x/home/3'],
    });
    const parsed = parseToolResult<{
      available: boolean;
      sample_count: number;
      cluster_id?: string;
      baseline_fire_factor?: number;
      not_covered: string[];
      samples: unknown[];
    }>(r);
    expect(parsed.available).toBe(true);
    expect(parsed.sample_count).toBe(3);
    expect(parsed.cluster_id).toBe('371110304002');
    // (5 + 6 + 7) / 3 = 6.0
    expect(parsed.baseline_fire_factor).toBe(6.0);
    expect(parsed.not_covered).toEqual(['landslide']);
    expect(parsed.samples).toHaveLength(3);
  });

  it('returns available: false when none of the samples have data', async () => {
    mockFetchHtml.mockResolvedValue('no data');
    const r = await areaHarness.callTool('redfin_get_area_climate_baseline', {
      sample_urls: ['/x/home/1', '/x/home/2'],
    });
    const parsed = parseToolResult<{ available: boolean; reason: string }>(r);
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toBe('no_first_street_data');
  });

  it('rejects sample sizes outside 2–10', async () => {
    const rOne = await areaHarness.callTool('redfin_get_area_climate_baseline', {
      sample_urls: ['/x/home/1'],
    });
    expect(rOne.isError).toBeTruthy();
    const rEleven = await areaHarness.callTool(
      'redfin_get_area_climate_baseline',
      {
        sample_urls: Array.from({ length: 11 }, (_, i) => `/x/${i}`),
      }
    );
    expect(rEleven.isError).toBeTruthy();
  });
});
