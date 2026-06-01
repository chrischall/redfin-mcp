import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mapWithConcurrency } from '@chrischall/mcp-utils/fetchproxy';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import { urlToPath } from '../url.js';

/**
 * Redfin's homedetails page server-renders climate risk data from
 * First Street Foundation directly into the page HTML. There's no
 * clean stingray endpoint for it (the URLs we probed all 404), but
 * the data shape inside the HTML is consistent enough to extract via
 * scoped regex.
 *
 * Three risk factors are surfaced:
 *   - floodData  (FEMA zones + 30-year flood-chance series)
 *   - fireData   (1-10 fireFactor + insurance-price band)
 *   - heatData   (1-10 heatFactor + cumulative-risk 0/5/10/15/20-year)
 *
 * Each factor is keyed by a shared `fsid` (First Street ID).
 *
 * Verified live 2026-05-23 against `/NY/Brooklyn/42-Monroe-St-11238/home/40732555`.
 */

export interface ClimateRiskReport {
  /** Always present. `false` for properties whose First Street data is
   * missing — `reason` then carries the discriminator. (#51) */
  available: boolean;
  /** When `available: false`, why. Enumerated; never free-text. */
  reason?: 'no_first_street_data' | 'new_construction' | 'address_outside_coverage';
  fsid?: number;
  /** Geographic cluster ID — properties with the same cluster_id
   * almost always share identical climate risk scores. Use this to
   * group N properties and skip redundant per-property fetches. (#53) */
  cluster_id?: string;
  flood?: {
    flood_factor: number;
    fema_zones?: string[];
    risk_direction?: number;
    annual_chance_30yr?: Array<{ year: number; threshold: string; chance_pct: number }>;
  };
  fire?: {
    fire_factor: number;
    risk_direction?: string;
    relative_risk?: number;
    insurance_price_low?: number;
    insurance_price_high?: number;
    number_of_providers?: number;
  };
  heat?: {
    heat_factor: number;
    risk_direction?: string;
    cumulative_risk_year0?: number;
    cumulative_risk_year5?: number;
    cumulative_risk_year10?: number;
    cumulative_risk_year15?: number;
    cumulative_risk_year20?: number;
  };
  /** Categories First Street does NOT cover. Surfaced on every
   * response so callers know what's missing without re-reading the
   * tool docs. Landslide is the canonical NC-mountains / Helene case. (#54) */
  not_covered: ['landslide'];
}

/**
 * Find a balanced JSON object that starts at `idx` (which should point
 * to a `{` character). Returns the matched string or null on failure.
 */
function extractBalancedJson(text: string, idx: number): string | null {
  if (text[idx] !== '{') return null;
  let depth = 0;
  // Naive brace-counting on purpose — the climate JSON is double-
  // encoded in the RSC stream (every `"` appears as `\"`), so the
  // usual "ignore-braces-inside-strings" optimization is fragile.
  // The climate payload has only numeric/short-string values, no
  // braces, so naive counting is safe.
  for (let i = idx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(idx, i + 1);
    }
  }
  return null;
}

/**
 * Extract a climate-risk data object (e.g. `"floodData":{...}`) from the
 * page HTML. Redfin embeds these inside a stream where strings are
 * double-encoded (the JSON contains escaped quotes inside the outer
 * HTML/JSON wrapper). We find the first occurrence and walk the
 * matching brace.
 *
 * The page string for flood looks like:
 *   `\"floodData\":{\"fsid\":361976049,\"floodFactor\":1,...}`
 *
 * The escape backslashes are themselves escaped — once we have the
 * matching {...} substring we run it through JSON.parse with one round
 * of un-escaping.
 */
export function extractClimateBlock(
  html: string,
  key: 'floodData' | 'fireData' | 'heatData'
): Record<string, unknown> | null {
  // Look for either escaped (`\"floodData\":`) or plain (`"floodData":`) form.
  const patterns = [`\\"${key}\\":`, `"${key}":`];
  for (const p of patterns) {
    const i = html.indexOf(p);
    if (i < 0) continue;
    const openBrace = html.indexOf('{', i + p.length);
    if (openBrace < 0) continue;
    const blob = extractBalancedJson(html, openBrace);
    if (!blob) continue;
    // The blob may have escaped quotes (\") from the surrounding stream.
    // Try parsing as-is first, then with one round of un-escaping.
    try {
      return JSON.parse(blob) as Record<string, unknown>;
    } catch {
      try {
        const unescaped = blob.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        return JSON.parse(unescaped) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
  }
  return null;
}

interface FloodChanceEntry {
  year?: number;
  threshold?: string;
  chance?: number;
  low?: number;
  mid?: number;
  high?: number;
}

interface FloodData {
  fsid?: number;
  floodFactor?: number;
  riskDirection?: number;
  femaZones?: string[];
  chance?: FloodChanceEntry[];
  cumulative30Year?: { chance?: number };
}

interface FireData {
  fsid?: number;
  fireFactor?: number;
  riskDirection?: string;
  relativeRisk?: number;
  lowInsurancePrice?: number;
  highInsurancePrice?: number;
  numberOfProviders?: number;
}

interface HeatData {
  fsid?: number;
  heatFactor?: number;
  riskDirection?: string;
  cumulativeRiskYear0?: number;
  cumulativeRiskYear5?: number;
  cumulativeRiskYear10?: number;
  cumulativeRiskYear15?: number;
  cumulativeRiskYear20?: number;
}

/**
 * Look for a census-tract / cluster-id signal in the HTML. Redfin's
 * page sometimes embeds the FIPS census tract (12-digit) alongside
 * the First Street IDs. When present, we surface it as `cluster_id`
 * so callers can group properties for batched calls (#53).
 */
export function extractClusterId(html: string): string | undefined {
  // Try common embed shapes: censusTract, tractId, gisTract.
  const patterns = [
    /\\?"censusTract\\?"\s*:\s*\\?"(\d{6,12})\\?"/,
    /\\?"tractId\\?"\s*:\s*\\?"(\d{6,12})\\?"/,
    /\\?"gisTract\\?"\s*:\s*\\?"(\d{6,12})\\?"/,
  ];
  for (const p of patterns) {
    const m = p.exec(html);
    if (m) return m[1];
  }
  return undefined;
}

export function formatClimate(
  flood: FloodData | null,
  fire: FireData | null,
  heat: HeatData | null,
  opts: { clusterId?: string } = {}
): ClimateRiskReport {
  // A parsed block alone isn't enough — Redfin sometimes embeds a
  // climate object with only an `fsid` and no factor scores. Require
  // at least one factor field actually be a number, matching the
  // downstream blocks below which are emitted on the same guard.
  const hasAny =
    (!!flood && typeof flood.floodFactor === 'number') ||
    (!!fire && typeof fire.fireFactor === 'number') ||
    (!!heat && typeof heat.heatFactor === 'number');
  const out: ClimateRiskReport = {
    available: hasAny,
    not_covered: ['landslide'],
  };
  if (!hasAny) {
    // #51 — explicit reason when data isn't available. We can't
    // distinguish "new_construction" from "address_outside_coverage"
    // from the page HTML alone today, so the conservative default
    // is "no_first_street_data". Future work: lift year-built from
    // a parallel ATF fetch to upgrade to "new_construction" when
    // appropriate.
    out.reason = 'no_first_street_data';
    return out;
  }
  const fsid = flood?.fsid ?? fire?.fsid ?? heat?.fsid;
  if (typeof fsid === 'number') out.fsid = fsid;
  if (opts.clusterId) out.cluster_id = opts.clusterId;
  if (flood && typeof flood.floodFactor === 'number') {
    out.flood = {
      flood_factor: flood.floodFactor,
      fema_zones: flood.femaZones,
      risk_direction: flood.riskDirection,
      annual_chance_30yr: flood.chance
        ?.filter((c) => typeof c.year === 'number')
        .map((c) => ({
          year: c.year as number,
          threshold: c.threshold ?? '',
          chance_pct:
            typeof c.mid === 'number'
              ? c.mid
              : typeof c.chance === 'number'
                ? c.chance
                : 0,
        })),
    };
  }
  if (fire && typeof fire.fireFactor === 'number') {
    out.fire = {
      fire_factor: fire.fireFactor,
      risk_direction: fire.riskDirection,
      relative_risk: fire.relativeRisk,
      insurance_price_low: fire.lowInsurancePrice,
      insurance_price_high: fire.highInsurancePrice,
      number_of_providers: fire.numberOfProviders,
    };
  }
  if (heat && typeof heat.heatFactor === 'number') {
    out.heat = {
      heat_factor: heat.heatFactor,
      risk_direction: heat.riskDirection,
      cumulative_risk_year0: heat.cumulativeRiskYear0,
      cumulative_risk_year5: heat.cumulativeRiskYear5,
      cumulative_risk_year10: heat.cumulativeRiskYear10,
      cumulative_risk_year15: heat.cumulativeRiskYear15,
      cumulative_risk_year20: heat.cumulativeRiskYear20,
    };
  }
  return out;
}

const CLIMATE_TOOL_DESCRIPTION =
  "First Street Foundation climate risk scores for a property. " +
  "COVERS: flood (factor 1–10, FEMA zones, 30-year annual chance series), " +
  "fire (factor 1–10, relative risk, insurance price band, provider count), " +
  "heat (factor 1–10, cumulative-risk projections at 0/5/10/15/20-year horizons). " +
  "DOES NOT COVER: landslide. This is the Helene-relevant risk vector in " +
  "the NC mountains market and many parts of California / the Pacific Northwest. " +
  "First Street has no landslide product — for that vector check the NC " +
  "Geological Survey landslide hazard maps (NC-specific) or USGS landslide " +
  "hazard data (national). Surfaced on every response as `not_covered: ['landslide']`. " +
  "Response shape: when First Street data is available, `available: true` with " +
  "the risk blocks; when not, `{ available: false, reason }` where reason is one of " +
  "`no_first_street_data`, `new_construction`, `address_outside_coverage`. " +
  "Sourced from Redfin's server-rendered homedetails HTML (no clean stingray " +
  "endpoint exists). Pass a homedetails URL (full or path). When a `cluster_id` " +
  "is surfaced, properties with the same value typically share identical climate " +
  "scores — use that to group N properties and skip redundant fetches.";

interface PerPropertyClimateResult {
  url: string;
  result?: ClimateRiskReport;
  error?: string;
}

function normalizeClimateUrl(url: string): string {
  if (url.startsWith('http')) return url;
  try {
    return `https://www.redfin.com${urlToPath(url)}`;
  } catch {
    return url;
  }
}

async function fetchOneClimate(
  client: RedfinClient,
  url: string
): Promise<PerPropertyClimateResult> {
  const normalizedUrl = normalizeClimateUrl(url);
  try {
    const path = urlToPath(url);
    const html = await client.fetchHtml(path);
    const flood = extractClimateBlock(html, 'floodData') as FloodData | null;
    const fire = extractClimateBlock(html, 'fireData') as FireData | null;
    const heat = extractClimateBlock(html, 'heatData') as HeatData | null;
    const clusterId = extractClusterId(html);
    return {
      url: normalizedUrl,
      result: formatClimate(flood, fire, heat, { clusterId }),
    };
  } catch (e) {
    return {
      url: normalizedUrl,
      error: (e as Error).message,
    };
  }
}

export function registerClimateTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_climate_risk',
    {
      title: 'Get Redfin climate risk for a property',
      description: CLIMATE_TOOL_DESCRIPTION,
      annotations: {
        title: 'Get Redfin climate risk for a property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z
          .string()
          .describe(
            'Redfin homedetails URL or path (e.g. /NY/Brooklyn/42-Monroe-St-11238/home/40732555)'
          ),
      },
    },
    async ({ url }) => {
      const one = await fetchOneClimate(client, url);
      if (one.error) throw new Error(one.error);
      return textResult({
        url: one.url,
        ...one.result!,
      });
    }
  );

  server.registerTool(
    'redfin_get_climate_risk_bulk',
    {
      title: 'Bulk-fetch Redfin climate risk for many properties',
      description:
        "Fetch climate risk for up to 100 property URLs in a single call. Same per-property shape as `redfin_get_climate_risk`; output preserves input order. Per-row error capture — properties without First Street data return `{ available: false, reason }` without aborting the batch. Server-side concurrency (~5 fetches in flight). Use this when batching ~60-property workflows where climate risk is the dominant cost. Limitations from the per-property tool apply (no landslide coverage).",
      annotations: {
        title: 'Bulk-fetch Redfin climate risk for many properties',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        urls: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe('Array of 1–100 Redfin homedetails URLs or paths.'),
      },
    },
    async ({ urls }) => {
      const results = await mapWithConcurrency(urls, 5, (u) =>
        fetchOneClimate(client, u)
      );
      // #53 cluster grouping: surface a `cluster_summary` so callers
      // can see "these 12 properties are all in cluster X". Only emitted
      // when at least 2 properties share a cluster_id.
      const clusters: Record<string, string[]> = {};
      for (const r of results) {
        const cid = r.result?.cluster_id;
        if (cid) (clusters[cid] ??= []).push(r.url);
      }
      const cluster_summary = Object.entries(clusters)
        .filter(([, urls]) => urls.length >= 2)
        .map(([cluster_id, urls]) => ({ cluster_id, urls }));
      return textResult({
        count: results.length,
        ok: results.filter((r) => !r.error && r.result?.available).length,
        unavailable: results.filter((r) => r.result && !r.result.available).length,
        errored: results.filter((r) => r.error).length,
        ...(cluster_summary.length > 0 ? { cluster_summary } : {}),
        results,
      });
    }
  );

  server.registerTool(
    'redfin_get_area_climate_baseline',
    {
      title: 'Sample climate baseline for an area by pulling a few addresses',
      description:
        "Fetch climate risk for a small set of representative URLs in an area, then return their averaged baseline values plus the shared cluster_id when present. Use this as a cheap area-level read BEFORE fanning out a per-property call: if all sample properties agree (same cluster_id, same fire/flood/heat factors), the baseline applies to the whole cluster and N redundant fetches are avoidable. Pass 2–10 URLs you believe represent the area; returns the aggregate plus the per-URL responses for transparency. Limitations of the per-property tool apply (no landslide coverage — note documented in the per-property tool description).",
      annotations: {
        title: 'Sample climate baseline for an area by pulling a few addresses',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        sample_urls: z
          .array(z.string())
          .min(2)
          .max(10)
          .describe('Array of 2–10 sample Redfin URLs representative of the area.'),
      },
    },
    async ({ sample_urls }) => {
      const results = await mapWithConcurrency(sample_urls, 5, (u) =>
        fetchOneClimate(client, u)
      );
      const available = results
        .map((r) => r.result)
        .filter((r): r is ClimateRiskReport => !!r && r.available);
      if (available.length === 0) {
        return textResult({
          available: false,
          reason: 'no_first_street_data' as const,
          samples: results,
        });
      }
      // Cluster agreement: if every available record shares the same
      // cluster_id, surface that as the baseline cluster.
      const clusterIds = new Set(
        available.map((r) => r.cluster_id).filter((c): c is string => !!c)
      );
      const baselineClusterId =
        clusterIds.size === 1 ? Array.from(clusterIds)[0] : undefined;
      const avg = (key: 'flood_factor' | 'fire_factor' | 'heat_factor') => {
        const vals: number[] = [];
        for (const r of available) {
          const block =
            key === 'flood_factor'
              ? r.flood?.flood_factor
              : key === 'fire_factor'
                ? r.fire?.fire_factor
                : r.heat?.heat_factor;
          if (typeof block === 'number') vals.push(block);
        }
        if (vals.length === 0) return undefined;
        return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      };
      return textResult({
        available: true,
        sample_count: available.length,
        cluster_id: baselineClusterId,
        baseline_fire_factor: avg('fire_factor'),
        baseline_flood_factor: avg('flood_factor'),
        baseline_heat_factor: avg('heat_factor'),
        not_covered: ['landslide'] as const,
        samples: results,
      });
    }
  );
}
