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
 * `loadCommunities` stays here (not realty-core) because it does
 * filesystem I/O (reads a JSON file named by `REDFIN_COMMUNITIES_FILE`),
 * which would break realty-core's no-I/O invariant. It's now a thin
 * binding over the shared `createCachedJsonArrayLoader` from
 * `@chrischall/mcp-utils` (see below) and resolves the community
 * vocabulary that feeds `extractFeatures`'s `communities` argument.
 */

import { createCachedJsonArrayLoader } from '@chrischall/mcp-utils';
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

/**
 * Resolve the active community vocabulary. Reads
 * `REDFIN_COMMUNITIES_FILE` (expects a JSON string array). Falls back
 * to `DEFAULT_COMMUNITIES` when unset, the file is missing, or the
 * JSON is malformed (with a stderr warning so misconfiguration is
 * visible). Cached per process keyed by the env-var value.
 *
 * Backed by the shared `createCachedJsonArrayLoader` from
 * `@chrischall/mcp-utils` (the env-named JSON-string-array file loader the
 * redfin/zillow/homes/onehome cohort each hand-rolled). It does the
 * `readEnvVar` placeholder-hardened lookup, parse, positive cache, and
 * negative-cache-on-missing/invalid for us.
 */
export const loadCommunities: () => string[] = createCachedJsonArrayLoader({
  envVar: 'REDFIN_COMMUNITIES_FILE',
  defaults: DEFAULT_COMMUNITIES,
  label: 'redfin-mcp',
});
