/**
 * Server-side keyword extraction from Redfin listing descriptions.
 * Lifts work that callers would otherwise do per-listing in chat — see
 * issue #33 for the motivation. A real session of 53 listings paid
 * ~100 KB of chat-history budget on marketing prose that callers
 * immediately keyword-parsed and discarded.
 *
 * The `extractFeatures` / `ExtractedFeatures` extraction logic now lives
 * in `@chrischall/realty-core` (round-4 candidate J): the canonical
 * helper reconciling the five cohort implementations. We re-export it
 * here so existing consumers keep importing from `../features.js`.
 *
 * `loadCommunities` stays local — it does filesystem I/O (reads a JSON
 * file named by `REDFIN_COMMUNITIES_FILE`), which would break
 * realty-core's no-I/O invariant. It resolves the community vocabulary
 * that feeds `extractFeatures`'s `communities` argument.
 */

import { existsSync, readFileSync } from 'node:fs';
import { extractFeatures, type ExtractedFeatures } from '@chrischall/realty-core';

export { extractFeatures };
export type { ExtractedFeatures };

/**
 * Default community vocabulary for the Lake Lure / mountain-NC market.
 * Override via the `REDFIN_COMMUNITIES_FILE` env var (JSON file
 * containing a string array) — see `loadCommunities`.
 */
export const DEFAULT_COMMUNITIES: string[] = [
  'Rumbling Bald',
  'Riverbend at Lake Lure',
  'The Lodges at Eagles Nest',
  'Hunters Ridge',
  'Beech Mountain Club',
  'The Cliffs',
  'Pinnacle Ridge',
  'Highland Heights',
  'Shelter Rock',
  'Charter Hills',
];

let cachedCommunities: string[] | null = null;
let cachedPath: string | null = null;

/**
 * Resolve the active community vocabulary. Reads
 * `REDFIN_COMMUNITIES_FILE` (expects a JSON string array). Falls back
 * to `DEFAULT_COMMUNITIES` when unset, the file is missing, or the
 * JSON is malformed (with a stderr warning so misconfiguration is
 * visible). Cached per process keyed by the env-var value.
 */
export function loadCommunities(): string[] {
  const path = process.env.REDFIN_COMMUNITIES_FILE?.trim();
  if (!path) {
    cachedCommunities = null;
    cachedPath = null;
    return DEFAULT_COMMUNITIES;
  }
  if (cachedCommunities && cachedPath === path) {
    return cachedCommunities;
  }
  if (!existsSync(path)) {
    console.error(
      `[redfin-mcp] REDFIN_COMMUNITIES_FILE="${path}" not found — falling back to DEFAULT_COMMUNITIES.`
    );
    return DEFAULT_COMMUNITIES;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
      console.error(
        `[redfin-mcp] REDFIN_COMMUNITIES_FILE="${path}" must be a JSON string array — falling back to DEFAULT_COMMUNITIES.`
      );
      return DEFAULT_COMMUNITIES;
    }
    cachedCommunities = parsed;
    cachedPath = path;
    return cachedCommunities;
  } catch (err) {
    console.error(
      `[redfin-mcp] failed to load REDFIN_COMMUNITIES_FILE="${path}": ${
        err instanceof Error ? err.message : String(err)
      } — falling back to DEFAULT_COMMUNITIES.`
    );
    return DEFAULT_COMMUNITIES;
  }
}
