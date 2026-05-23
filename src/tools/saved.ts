import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';

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
 *      to fetch the home-card details for each.
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
}

interface HomeCard {
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

function unwrap<T>(x: T | { value?: T } | undefined): T | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'object' && 'value' in (x as object)) {
    return (x as { value?: T }).value;
  }
  return x as T;
}

export function formatHomeCard(hc: HomeCard): FormattedSavedHome | null {
  if (!hc.propertyId) return null;
  const c = hc.commonHomeData ?? {};
  const url = c.url
    ? c.url.startsWith('http')
      ? c.url
      : `https://www.redfin.com${c.url}`
    : `https://www.redfin.com/home/${hc.propertyId}`;
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

export function registerSavedTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_saved_homes',
    {
      title: 'Get my saved (favorited) Redfin homes',
      description:
        "The signed-in user's favorited homes on redfin.com. Returns address, price, beds/baths, status. Requires the user to be signed in. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get my saved (favorited) Redfin homes',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const html = await client.fetchHtml('/myredfin/favorites');
      const ids = extractFavoritePropertyIds(html);
      if (ids.length === 0) return textResult([]);
      const params = new URLSearchParams({ b: ids.join(','), r: '' });
      const env = await client.fetchStingrayJson<HomecardsPayload>(
        `/stingray/do/api/v3/favorites/homecards?${params.toString()}`
      );
      const cards = env.payload?.homecards ?? [];
      const formatted = cards
        .map(formatHomeCard)
        .filter((c): c is FormattedSavedHome => c !== null);
      return textResult(formatted);
    }
  );

  server.registerTool(
    'redfin_get_saved_searches',
    {
      title: 'Get my saved Redfin searches',
      description:
        "The signed-in user's saved searches on redfin.com, derived from the saved-searches page HTML. Each entry is `{ url, region_segment, display_text }`. Requires the user to be signed in. Returns an empty array if the user has none. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get my saved Redfin searches',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const html = await client.fetchHtml('/myredfin/saved-searches');
      const searches = extractSavedSearches(html);
      return textResult(searches);
    }
  );
}
