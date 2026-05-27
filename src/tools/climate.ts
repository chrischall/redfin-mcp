import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
  fsid?: number;
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
  key: 'floodData' | 'fireData' | 'heatData' | 'windData'
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

export function formatClimate(
  flood: FloodData | null,
  fire: FireData | null,
  heat: HeatData | null
): ClimateRiskReport {
  const out: ClimateRiskReport = {};
  const fsid = flood?.fsid ?? fire?.fsid ?? heat?.fsid;
  if (typeof fsid === 'number') out.fsid = fsid;
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

export function registerClimateTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_climate_risk',
    {
      title: 'Get Redfin climate risk for a property',
      description:
        "First Street Foundation climate risk scores for a property. COVERS: flood (factor 1–10, FEMA zones, 30-year annual chance series), fire (factor 1–10, relative risk, insurance price band, provider count), heat (factor 1–10, cumulative-risk projections at 0/5/10/15/20-year horizons). DOES NOT COVER: landslide — this is the Helene-relevant risk vector in the NC mountains market and parts of CA / the Pacific Northwest. First Street has no landslide product. For that vector use the NC Geological Survey landslide hazard maps (NC) or USGS landslide hazard data (national). When data is missing, the response shape is currently an empty object — companion issue #51 tracks moving to `{ available: false, reason }` with reasons including new_construction, address_outside_coverage, and no_first_street_data. Sourced from Redfin's server-rendered homedetails HTML.",
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
      const path = urlToPath(url);
      const html = await client.fetchHtml(path);
      const flood = extractClimateBlock(html, 'floodData') as FloodData | null;
      const fire = extractClimateBlock(html, 'fireData') as FireData | null;
      const heat = extractClimateBlock(html, 'heatData') as HeatData | null;
      return textResult({
        url: url.startsWith('http') ? url : `https://www.redfin.com${path}`,
        ...formatClimate(flood, fire, heat),
      });
    }
  );
}
