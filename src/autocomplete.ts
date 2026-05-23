/**
 * Resolve a free-text location string to a Redfin region (region_id +
 * region_type) via the `/stingray/do/location-autocomplete` endpoint.
 *
 * Verified live (2026-05-23): autocomplete returns an envelope with
 * `payload.sections[]`, where the first section is `Places` and each
 * row has `id` (formatted as `"<type>_<region_id>"`), `name`, `url`,
 * etc. We pick the first Places row.
 */
import type { RedfinClient } from './client.js';

export interface RedfinRegion {
  /** Numeric region id, e.g. 30749 for New York City. */
  region_id: number;
  /** Region type integer; 6 is common for both cities and neighborhoods. */
  region_type: number;
  /** Human-readable name (e.g. "Brooklyn"). */
  name: string;
  /** Subtitle context (e.g. "New York, NY, USA"). */
  sub_name?: string;
  /** Canonical Redfin URL path for the region (e.g. /city/30749/NY/New-York). */
  url: string;
}

interface AutocompleteRow {
  id?: string;
  name?: string;
  subName?: string;
  url?: string;
}

interface AutocompleteSection {
  name?: string;
  rows?: AutocompleteRow[];
}

interface AutocompletePayload {
  sections?: AutocompleteSection[];
}

/**
 * Parse the `id` field which Redfin formats as `"<type>_<region_id>"`.
 * Returns null on malformed input.
 */
export function parseRegionId(
  id: string | undefined
): { region_id: number; region_type: number } | null {
  if (!id) return null;
  const m = /^(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  return { region_type: parseInt(m[1], 10), region_id: parseInt(m[2], 10) };
}

/**
 * Look up the first matching Places region for a free-text query.
 * Returns null if no Places result was found.
 */
export async function resolveRegion(
  client: RedfinClient,
  query: string
): Promise<RedfinRegion | null> {
  const params = new URLSearchParams({
    location: query,
    start: '0',
    count: '10',
    v: '2',
    iss: 'false',
    ooa: 'true',
    mrs: 'false',
  });
  const env = await client.fetchStingrayJson<AutocompletePayload>(
    `/stingray/do/location-autocomplete?${params.toString()}`
  );
  const sections = env.payload?.sections ?? [];
  const places = sections.find((s) => s.name === 'Places');
  const first = places?.rows?.[0];
  if (!first) return null;
  const parsed = parseRegionId(first.id);
  if (!parsed) return null;
  return {
    region_id: parsed.region_id,
    region_type: parsed.region_type,
    name: first.name ?? '',
    sub_name: first.subName,
    url: first.url ?? '',
  };
}
