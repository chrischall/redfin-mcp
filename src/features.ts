/**
 * Server-side keyword extraction from Redfin listing descriptions.
 * Lifts work that callers would otherwise do per-listing in chat — see
 * issue #33 for the motivation. A real session of 53 listings paid
 * ~100 KB of chat-history budget on marketing prose that callers
 * immediately keyword-parsed and discarded.
 *
 * Pure-function design — `extractFeatures` takes a description string
 * and a community-name vocabulary and returns the structured result.
 * The vocabulary is resolved separately via `loadCommunities` so the
 * env-var override path can be tested in isolation.
 *
 * REGRESSION-PINNED: `unfinished basement` substring-matches inside
 * `finished basement` if you check `finished` first. The detector
 * checks `unfinished` FIRST. Multiple tests pin this behaviour.
 */

import { existsSync, readFileSync } from 'node:fs';

export interface ExtractedFeatures {
  lake_front: boolean;
  hot_tub: boolean;
  basement: 'finished' | 'unfinished' | 'partial' | 'unknown' | null;
  furnished: 'fully' | 'partial' | 'negotiable' | null;
  dock: 'private' | 'community' | 'marina' | 'boat_slip' | null;
  community: string | null;
}

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

// Pre-compiled regex constants. `i` for case-insensitivity throughout.
const LAKE_FRONT_RE = /\b(?:lakefront|lake front|waterfront)\b/i;
const HOT_TUB_RE = /\bhot tub\b/i;

// Accepts both word orders within a short window — "unfinished basement"
// AND "basement is unfinished" / "basement, unfinished". The window
// (~30 chars / no sentence break) catches typical phrasing without
// chasing across sentences. Same shape for the other qualifiers.
const BASEMENT_UNFINISHED_RE =
  /\b(?:unfinished basement|basement[^.!?]{0,30}?\bunfinished)\b/i;
const BASEMENT_FINISHED_RE =
  /\b(?:finished basement|basement[^.!?]{0,30}?\bfinished)\b/i;
// `partial basement` is already covered by the first alternative when
// both `(?:ly)?` and `(?:finished )?` don't match — keep the regex tight.
const BASEMENT_PARTIAL_RE =
  /\b(?:partial(?:ly)? (?:finished )?basement|basement[^.!?]{0,30}?\bpartial(?:ly)?)\b/i;
const BASEMENT_MENTIONED_RE = /\bbasement\b/i;

const FURNISHED_FULLY_RE = /\b(?:fully furnished|sold furnished|turnkey)\b/i;
const FURNISHED_PARTIAL_RE =
  /\b(?:almost furnished|furnished with exceptions|with exceptions)\b/i;
const FURNISHED_NEGOTIABLE_RE = /\bfurnishings (?:are )?negotiable\b/i;

const DOCK_PRIVATE_RE = /\bprivate (?:boat )?dock\b/i;
const DOCK_COMMUNITY_RE = /\b(?:community|shared) dock\b/i;
// Tighten "marina" — naked `\bmarina\b` false-positives on place names
// like "123 Marina Dr", "Marina Bay", or "Marina del Rey". Use a negative
// lookahead for the common place-suffixes so the dock signal stays clean.
const DOCK_MARINA_RE =
  /\bmarina\b(?!\s+(?:del|bay|dr|drive|blvd|boulevard|st|street|ave|avenue))/i;
const DOCK_BOAT_SLIP_RE = /\bboat ?slip\b/i;

/**
 * Extract structured features from a listing description.
 */
export function extractFeatures(
  description: string | undefined,
  communities: string[]
): ExtractedFeatures {
  const text = description ?? '';
  return {
    lake_front: LAKE_FRONT_RE.test(text),
    hot_tub: HOT_TUB_RE.test(text),
    basement: detectBasement(text),
    furnished: detectFurnished(text),
    dock: detectDock(text),
    community: detectCommunity(text, communities),
  };
}

function detectBasement(text: string): ExtractedFeatures['basement'] {
  // ORDER MATTERS. `finished basement` substring-matches inside
  // `unfinished basement`; check the longer phrase first.
  if (BASEMENT_UNFINISHED_RE.test(text)) return 'unfinished';
  if (BASEMENT_PARTIAL_RE.test(text)) return 'partial';
  if (BASEMENT_FINISHED_RE.test(text)) return 'finished';
  if (BASEMENT_MENTIONED_RE.test(text)) return 'unknown';
  return null;
}

function detectFurnished(text: string): ExtractedFeatures['furnished'] {
  if (FURNISHED_FULLY_RE.test(text)) return 'fully';
  if (FURNISHED_NEGOTIABLE_RE.test(text)) return 'negotiable';
  if (FURNISHED_PARTIAL_RE.test(text)) return 'partial';
  return null;
}

function detectDock(text: string): ExtractedFeatures['dock'] {
  // Specificity order: private > community > boat_slip > marina.
  // (Marina is the most general and shows up in lots of incidental
  // contexts; check it last.)
  if (DOCK_PRIVATE_RE.test(text)) return 'private';
  if (DOCK_COMMUNITY_RE.test(text)) return 'community';
  if (DOCK_BOAT_SLIP_RE.test(text)) return 'boat_slip';
  if (DOCK_MARINA_RE.test(text)) return 'marina';
  return null;
}

function detectCommunity(text: string, communities: string[]): string | null {
  if (communities.length === 0 || text.length === 0) return null;
  // Find the EARLIEST match in document order — first-by-position, not
  // first-by-vocabulary-position. A listing that mentions both
  // "Riverbend at Lake Lure" and "Rumbling Bald" should resolve to
  // whichever is mentioned first in the prose.
  let earliest: { name: string; index: number } | null = null;
  for (const name of communities) {
    // Word-boundary anchors handle case + trailing punctuation naturally.
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
    const m = re.exec(text);
    if (m && (earliest === null || m.index < earliest.index)) {
      earliest = { name, index: m.index };
    }
  }
  return earliest?.name ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
