import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { RedfinClient } from '../client.js';
import { minifiedResult, unwrapValue as unwrap } from '../mcp.js';
import { viewArg, viewResponse } from '../view.js';
import { redfinPhotoUrl } from './photos.js';

/**
 * Signed-in-user surfaces. Both pages require an authenticated
 * redfin.com session in the bridged Chrome tab.
 *
 * Saved homes flow:
 *   1. GET `/myredfin/favorites` HTML. The page is a React Server
 *      Component (no __NEXT_DATA__), but the user's favorited
 *      propertyIds are embedded inline as `/home/<id>` URLs.
 *   2. Regex out the propertyIds.
 *   3. GET `/stingray/do/api/v3/favorites/homecards?b=<csv-ids>&r=`
 *      (≤50 ids per request) to fetch the home-card details for each,
 *      then keep only cards Redfin flags as favorites (not X'd out).
 *
 * Saved searches:
 *   1. GET `/myredfin/saved-searches` HTML. Per-search detail (name,
 *      search URL, alert frequency) is rendered into the HTML by the
 *      RSC. We extract `/{city,zipcode,neighborhood,county}/...` URLs
 *      and their adjacent display text.
 *
 * Verified live 2026-05-23.
 */

export interface FormattedSavedHome {
  property_id: number;
  url: string;
  status?: string;
  price?: number;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  /** Primary photo URL constructed from mlsId + dataSourceId. */
  image_url?: string;
  /** Mid-size variant of the primary photo, useful for thumbnails. */
  thumbnail_url?: string;
  /** Total photos available, parsed from the `0-N:0` availablePhotos range. */
  photo_count?: number;
  is_favorite?: boolean;
}

export interface FormattedSavedSearch {
  url: string;
  region_segment: string;
  display_text?: string;
}

interface HomeCardCommonData {
  url?: string;
  status?: { displayValue?: string };
  priceInfo?: { amount?: number };
  entireAddressString?: string;
  city?: string;
  state?: string;
  zip?: string;
  beds?: number;
  baths?: number;
  sqFt?: { value?: number } | number;
  /** Redfin MLS identifier — combined with dataSourceId to build CDN photo URLs. */
  mlsId?: string | number;
  /** Redfin data-source / MLS provider ID (e.g. 641 for one NY MLS). */
  dataSourceId?: number;
  /**
   * Range of available photo indices, formatted "<lo>-<hi>:<unused>"
   * (e.g. "0-20:0" → 21 photos at indices 0..20).
   */
  availablePhotos?: string;
}

export interface HomeCard {
  propertyId?: number;
  isFavorite?: boolean;
  isXOut?: boolean;
  commonHomeData?: HomeCardCommonData;
}

interface HomecardsPayload {
  homecards?: HomeCard[];
}

/**
 * Extract the user's favorited property IDs from the favorites page HTML.
 * Returns unique IDs in their order of first appearance.
 */
export function extractFavoritePropertyIds(html: string): number[] {
  const seen = new Set<number>();
  for (const m of html.matchAll(/\/home\/(\d+)/g)) {
    const id = parseInt(m[1], 10);
    if (!Number.isNaN(id)) seen.add(id);
  }
  return [...seen];
}

/**
 * Parse the `availablePhotos` range string (e.g. "0-20:0") into a total
 * photo count. Returns undefined when the field is missing or unparseable.
 */
export function parseAvailablePhotos(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+)-(\d+)(?::|$)/.exec(s);
  if (!m) return undefined;
  const lo = parseInt(m[1], 10);
  const hi = parseInt(m[2], 10);
  if (Number.isNaN(lo) || Number.isNaN(hi) || hi < lo) return undefined;
  return hi - lo + 1;
}

/** Max property ids per homecards request (keeps the `b=` URL bounded). */
export const HOMECARDS_BATCH_SIZE = 50;

/**
 * A homecard belongs in "my saved homes" unless Redfin says otherwise:
 * `isFavorite: false` (a non-favorite the page scrape swept up) or
 * `isXOut: true` (a home the user dismissed). A card with no flag is kept.
 */
export function isSavedCard(hc: HomeCard): boolean {
  return hc.isFavorite !== false && hc.isXOut !== true;
}

export function formatHomeCard(hc: HomeCard): FormattedSavedHome | null {
  if (!hc.propertyId) return null;
  const c = hc.commonHomeData ?? {};
  const url = c.url
    ? c.url.startsWith('http')
      ? c.url
      : `https://www.redfin.com${c.url}`
    : `https://www.redfin.com/home/${hc.propertyId}`;
  // Build CDN photo URLs when we have both ID handles. Redfin's
  // homecards endpoint omits a photoUrls bundle, but the
  // (dataSourceId, mlsId) pair is the canonical handle into their
  // photo CDN.
  let image_url: string | undefined;
  let thumbnail_url: string | undefined;
  if (c.mlsId !== undefined && c.mlsId !== '' && typeof c.dataSourceId === 'number') {
    image_url = redfinPhotoUrl({
      dataSourceId: c.dataSourceId,
      mlsId: c.mlsId,
      index: 0,
      size: 'big',
    });
    thumbnail_url = redfinPhotoUrl({
      dataSourceId: c.dataSourceId,
      mlsId: c.mlsId,
      index: 0,
      size: 'mid',
    });
  }
  return {
    property_id: hc.propertyId,
    url,
    status: c.status?.displayValue,
    price: c.priceInfo?.amount,
    address: c.entireAddressString,
    city: c.city,
    state: c.state,
    zip: c.zip,
    beds: c.beds,
    baths: c.baths,
    sqft: unwrap(c.sqFt),
    image_url,
    thumbnail_url,
    photo_count: parseAvailablePhotos(c.availablePhotos),
    is_favorite: hc.isFavorite,
  };
}

/**
 * Extract saved-search entries from the saved-searches page HTML.
 * Each entry has a region URL (e.g. /city/30749/NY/New-York) and a
 * nearby anchor's text. We dedupe by URL.
 */
export function extractSavedSearches(html: string): FormattedSavedSearch[] {
  const re =
    /(?:href|data-rf-test-name|searchUrl)="(\/(?:city|zipcode|neighborhood|county|state)\/[^"<>?#]+)"(?:[^>]*>([^<]{1,80}))?/g;
  const seen = new Map<string, FormattedSavedSearch>();
  for (const m of html.matchAll(re)) {
    const path = m[1];
    const text = m[2]?.trim();
    if (seen.has(path)) continue;
    seen.set(path, {
      url: `https://www.redfin.com${path}`,
      region_segment: path,
      display_text: text || undefined,
    });
  }
  return [...seen.values()];
}

const NO_FAVORITES_NOTE =
  'The favorites page contained no /home/<id> links. Either the signed-in account has no saved homes, ' +
  'or Redfin changed the favorites page and the scrape found none — check redfin.com/myredfin/favorites ' +
  'in the bridged tab to tell which.';

const NO_SEARCHES_NOTE =
  'The saved-searches page contained no region search links. Either the signed-in account has no saved searches, ' +
  'or Redfin changed the page and the scrape found none — check redfin.com/myredfin/saved-searches ' +
  'in the bridged tab to tell which.';

export function registerSavedTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_saved_homes',
    {
      title: 'Get my saved (favorited) Redfin homes',
      description:
        "The signed-in user's favorited homes on redfin.com. Returns `{ count, homes }` — each home has address, price, beds/baths, status — plus a `note` when none were found (no favorites vs. a page-scrape miss). Requires the user to be signed in. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get my saved (favorited) Redfin homes',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),}),
    },
    async ({ view }) => {
      const html = await client.fetchHtml('/myredfin/favorites');
      const ids = extractFavoritePropertyIds(html);
      // Same `{ count, ... }` envelope as every other read tool, plus a
      // note when the scrape found nothing, so "signed in, no favorites" and
      // "the page changed and the regex missed" aren't silently identical
      // (fleet-audit #1094).
      if (ids.length === 0) {
        return minifiedResult({
          count: 0,
          homes: [],
          note: NO_FAVORITES_NOTE,
        });
      }
      // The id scrape is a regex over the whole page, so it can pick up
      // non-favorite cards (recently viewed, recommendations); the homecards
      // response's own isFavorite/isXOut flags are the authority. Ids go out
      // in batches so a long favorites list can't blow the URL length
      // (fleet-audit #668).
      const cards: HomeCard[] = [];
      for (let i = 0; i < ids.length; i += HOMECARDS_BATCH_SIZE) {
        const batch = ids.slice(i, i + HOMECARDS_BATCH_SIZE);
        const params = new URLSearchParams({ b: batch.join(','), r: '' });
        const env = await client.fetchStingrayJson<HomecardsPayload>(
          `/stingray/do/api/v3/favorites/homecards?${params.toString()}`
        );
        cards.push(...(env.payload?.homecards ?? []));
      }
      const formatted = cards
        .filter(isSavedCard)
        .map(formatHomeCard)
        .filter((c): c is FormattedSavedHome => c !== null);
      return viewResponse(view, { count: formatted.length, homes: formatted });
    }
  );

  server.registerTool(
    'redfin_get_saved_searches',
    {
      title: 'Get my saved Redfin searches',
      description:
        "The signed-in user's saved searches on redfin.com, derived from the saved-searches page HTML. Returns `{ count, searches }`; each entry is `{ url, region_segment, display_text }`. Requires the user to be signed in. When none are found, `searches` is empty and a `note` explains it may be no saved searches or a page-scrape miss. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get my saved Redfin searches',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),}),
    },
    async ({ view }) => {
      const html = await client.fetchHtml('/myredfin/saved-searches');
      const searches = extractSavedSearches(html);
      return viewResponse(view, {
        count: searches.length,
        searches,
        ...(searches.length === 0 ? { note: NO_SEARCHES_NOTE } : {}),
      });
    }
  );
}
