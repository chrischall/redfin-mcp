import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  buildCanonicalUrl,
  resolveIds,
  type AboveTheFoldPayload,
} from './properties.js';

/**
 * Redfin property photos live in `aboveTheFold.mediaBrowserInfo.photos[]`.
 * Each photo carries a `photoUrls` bundle of CDN URLs at progressively
 * smaller sizes — we surface the four useful ones plus a thumbnail.
 *
 * For off-market or stub listings, mediaBrowserInfo may be absent or
 * empty; we return `count: 0` and an empty `photos: []` rather than
 * synthesizing URLs blindly. (Saved-home cards have a separate path —
 * `saved.ts` constructs primary photo URLs from `mlsId` + `dataSourceId`
 * since the homecards endpoint omits the photoUrls bundle.)
 *
 * The Redfin photo CDN URL pattern, for reference:
 *
 *   https://ssl.cdn-redfin.com/photo/<dataSourceId>/<size>/<last3>/<file>
 *
 * where `<last3>` is the last 3 characters of the mlsId, left-padded
 * with zeros if shorter. The two file conventions we see:
 *   - bigphoto/  → `<mlsId>_<index>.jpg`
 *   - mbphotov3/ → `genMid.<mlsId>_<index>_0.jpg`
 *
 * Verified live 2026-05-23 against /NY/Brooklyn/42-Monroe-St-11238/home/40732555
 * and the favorites/homecards endpoint.
 */

interface MediaPhotoUrls {
  fullScreenPhotoUrl?: string;
  nonFullScreenPhotoUrl?: string;
  nonFullScreenPhotoUrlCompressed?: string;
  lightboxListUrl?: string;
}

interface MediaThumbnail {
  thumbnailUrl?: string;
}

export interface MediaPhoto {
  photoUrls?: MediaPhotoUrls;
  thumbnailData?: MediaThumbnail;
  photoText?: string;
}

export interface FormattedPhoto {
  url_fullscreen?: string;
  url_large?: string;
  url_medium?: string;
  url_lightbox?: string;
  thumbnail_url?: string;
  caption?: string;
}

/**
 * Return the last 3 chars of an mlsId as a string, left-padded with
 * zeros. Redfin's CDN groups photos by these 3 characters as a shard
 * directory: e.g. mlsId "2111124202183295849" → "849". This matches
 * the URL form `/photo/641/bigphoto/849/2111124202183295849_0.jpg`.
 */
export function redfinPhotoLast3(mlsId: string | number): string {
  return String(mlsId).padStart(3, '0').slice(-3);
}

/**
 * Build a Redfin CDN photo URL from primitive fields. Used by
 * `tools/saved.ts` to surface a thumbnail for saved homes, where the
 * homecards endpoint exposes only `mlsId` + `dataSourceId` (no photoUrls
 * bundle). The `size` arg selects between Redfin's two file
 * conventions; `big` (default) maps to the gallery hero, `mid` to the
 * mbphotov3 mid-size thumbnail.
 *
 * The CDN's per-index suffix convention is asymmetric:
 *   - index 0 → `<mlsId>_0.jpg`        (single `_0`)
 *   - index N → `<mlsId>_<N>_0.jpg`    (double `_0`)
 *
 * Verified live 2026-05-23: photo[0] is `2111124202183295849_0.jpg` but
 * photo[5] is `2111124202183295849_5_0.jpg`. Both `bigphoto/` and
 * `mbphotov3/` follow this pattern.
 */
export function redfinPhotoUrl(args: {
  dataSourceId: number;
  mlsId: string | number;
  index?: number;
  size?: 'big' | 'mid';
}): string {
  const idx = args.index ?? 0;
  const last3 = redfinPhotoLast3(args.mlsId);
  const mls = String(args.mlsId);
  const suffix = idx === 0 ? '0' : `${idx}_0`;
  if (args.size === 'mid') {
    return `https://ssl.cdn-redfin.com/photo/${args.dataSourceId}/mbphotov3/${last3}/genMid.${mls}_${suffix}.jpg`;
  }
  return `https://ssl.cdn-redfin.com/photo/${args.dataSourceId}/bigphoto/${last3}/${mls}_${suffix}.jpg`;
}

export function formatPhoto(p: MediaPhoto): FormattedPhoto | null {
  const u = p.photoUrls ?? {};
  const thumb = p.thumbnailData?.thumbnailUrl;
  if (
    !u.fullScreenPhotoUrl &&
    !u.nonFullScreenPhotoUrl &&
    !u.nonFullScreenPhotoUrlCompressed &&
    !u.lightboxListUrl &&
    !thumb
  ) {
    return null;
  }
  const out: FormattedPhoto = {};
  if (u.fullScreenPhotoUrl) out.url_fullscreen = u.fullScreenPhotoUrl;
  if (u.nonFullScreenPhotoUrl) out.url_large = u.nonFullScreenPhotoUrl;
  if (u.nonFullScreenPhotoUrlCompressed)
    out.url_medium = u.nonFullScreenPhotoUrlCompressed;
  if (u.lightboxListUrl) out.url_lightbox = u.lightboxListUrl;
  if (thumb) out.thumbnail_url = thumb;
  if (p.photoText) out.caption = p.photoText;
  return out;
}

interface MediaBrowserInfoFull {
  photos?: MediaPhoto[];
}

interface AboveTheFoldWithMedia extends AboveTheFoldPayload {
  mediaBrowserInfo?: MediaBrowserInfoFull;
}

export function registerPhotosTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_get_property_photos',
    {
      title: 'Get Redfin property photo gallery',
      description:
        "The full photo gallery for a Redfin property — every image in mediaBrowserInfo. Each entry returns CDN URLs at multiple sizes (fullscreen, large, medium, lightbox) plus a thumbnail and the photo's caption when set. Provide either `url` (full Redfin homedetails URL or path; we resolve to IDs via initialInfo) or `property_id` + `listing_id` (skip the resolve step). Returns `{ property_id, listing_id, count, photos }`. Off-market or stub listings may return count=0. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Redfin property photo gallery',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            'Redfin homedetails URL or path (e.g. /NY/Brooklyn/42-Monroe-St-11238/home/40732555)'
          ),
        property_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Numeric Redfin property ID. Pair with listing_id to skip the URL resolve step.'
          ),
        listing_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Numeric Redfin listing ID. Required when property_id is provided.'
          ),
      },
    },
    async ({ url, property_id, listing_id }) => {
      const ids = await resolveIds(client, { url, property_id, listing_id });
      const atfParams = new URLSearchParams({
        propertyId: String(ids.propertyId),
        accessLevel: '1',
        listingId: String(ids.listingId),
      });
      const env = await client.fetchStingrayJson<AboveTheFoldWithMedia>(
        `/stingray/api/home/details/aboveTheFold?${atfParams.toString()}`
      );
      const atf = env.payload ?? null;
      const rawPhotos = atf?.mediaBrowserInfo?.photos ?? [];
      const photos = rawPhotos
        .map(formatPhoto)
        .filter((p): p is FormattedPhoto => p !== null);
      const canonicalUrl = url
        ? ids.canonicalUrl
        : (buildCanonicalUrl(atf?.addressSectionInfo, ids.propertyId) ?? ids.canonicalUrl);
      return textResult({
        property_id: ids.propertyId,
        listing_id: ids.listingId,
        url: canonicalUrl,
        count: photos.length,
        photos,
      });
    }
  );
}
