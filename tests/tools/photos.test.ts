import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import {
  formatPhoto,
  redfinPhotoUrl,
  redfinPhotoLast3,
  registerPhotosTools,
} from '../../src/tools/photos.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchStingrayJson = vi.fn();
const mockClient = {
  fetchStingrayJson: mockFetchStingrayJson,
} as unknown as RedfinClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('redfinPhotoLast3', () => {
  it('returns the trailing 3 chars of the mlsId string', () => {
    expect(redfinPhotoLast3('2111124202183295849')).toBe('849');
  });

  it('pads short mlsIds with leading zeros so the path slot stays 3-wide', () => {
    expect(redfinPhotoLast3('5')).toBe('005');
    expect(redfinPhotoLast3('42')).toBe('042');
  });

  it('handles numeric mlsIds', () => {
    expect(redfinPhotoLast3(12345)).toBe('345');
  });
});

describe('redfinPhotoUrl', () => {
  it('builds the canonical bigphoto primary URL at index 0', () => {
    expect(
      redfinPhotoUrl({ dataSourceId: 641, mlsId: '2111124202183295849', index: 0 })
    ).toBe(
      'https://ssl.cdn-redfin.com/photo/641/bigphoto/849/2111124202183295849_0.jpg'
    );
  });

  it('uses the double-_0 suffix for non-zero bigphoto indices', () => {
    // Verified live: photo[5] is `<mls>_5_0.jpg`, not `<mls>_5.jpg`.
    expect(
      redfinPhotoUrl({ dataSourceId: 641, mlsId: '2111124202183295849', index: 5 })
    ).toBe(
      'https://ssl.cdn-redfin.com/photo/641/bigphoto/849/2111124202183295849_5_0.jpg'
    );
  });

  it('builds the mbphotov3 mid-size URL at index 0 (single _0)', () => {
    // Verified live: photo[0] is `genMid.<mls>_0.jpg`, NOT `genMid.<mls>_0_0.jpg`.
    expect(
      redfinPhotoUrl({
        dataSourceId: 641,
        mlsId: '2111124202183295849',
        index: 0,
        size: 'mid',
      })
    ).toBe(
      'https://ssl.cdn-redfin.com/photo/641/mbphotov3/849/genMid.2111124202183295849_0.jpg'
    );
  });

  it('builds the mbphotov3 mid-size URL at index N (double _0)', () => {
    expect(
      redfinPhotoUrl({
        dataSourceId: 641,
        mlsId: '2111124202183295849',
        index: 3,
        size: 'mid',
      })
    ).toBe(
      'https://ssl.cdn-redfin.com/photo/641/mbphotov3/849/genMid.2111124202183295849_3_0.jpg'
    );
  });
});

describe('formatPhoto', () => {
  it('extracts the fullscreen + compressed + thumbnail URLs', () => {
    expect(
      formatPhoto({
        photoUrls: {
          fullScreenPhotoUrl: 'https://cdn/full.jpg',
          nonFullScreenPhotoUrl: 'https://cdn/big.jpg',
          nonFullScreenPhotoUrlCompressed: 'https://cdn/mid.jpg',
          lightboxListUrl: 'https://cdn/lightbox.jpg',
        },
        thumbnailData: { thumbnailUrl: 'https://cdn/thumb.jpg' },
        photoText: 'Front exterior',
      })
    ).toEqual({
      url_fullscreen: 'https://cdn/full.jpg',
      url_large: 'https://cdn/big.jpg',
      url_medium: 'https://cdn/mid.jpg',
      url_lightbox: 'https://cdn/lightbox.jpg',
      thumbnail_url: 'https://cdn/thumb.jpg',
      caption: 'Front exterior',
    });
  });

  it('returns null when the photo has no URLs at all', () => {
    expect(formatPhoto({ photoUrls: {}, thumbnailData: {} })).toBeNull();
  });
});

describe('redfin_get_property_photos tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerPhotosTools(server, mockClient)
    );
  });

  it('skips initialInfo when property_id+listing_id are provided + returns gallery', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        mediaBrowserInfo: {
          photos: [
            {
              photoUrls: { fullScreenPhotoUrl: 'https://cdn/0.jpg' },
              thumbnailData: { thumbnailUrl: 'https://cdn/t0.jpg' },
            },
            {
              photoUrls: { fullScreenPhotoUrl: 'https://cdn/1.jpg' },
              thumbnailData: { thumbnailUrl: 'https://cdn/t1.jpg' },
            },
          ],
        },
      },
    });

    const r = await harness.callTool('redfin_get_property_photos', {
      property_id: 42,
      listing_id: 99,
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(1);
    const path = mockFetchStingrayJson.mock.calls[0][0] as string;
    expect(path).toMatch(/aboveTheFold/);
    expect(path).toMatch(/propertyId=42/);
    expect(path).toMatch(/listingId=99/);

    const parsed = parseToolResult<{
      property_id: number;
      count: number;
      photos: Array<{ url_fullscreen: string; thumbnail_url: string }>;
    }>(r);
    expect(parsed.property_id).toBe(42);
    expect(parsed.count).toBe(2);
    expect(parsed.photos[0].url_fullscreen).toBe('https://cdn/0.jpg');
  });

  it('resolves IDs from URL via initialInfo before aboveTheFold', async () => {
    mockFetchStingrayJson
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { propertyId: 1, listingId: 2 },
      })
      .mockResolvedValueOnce({
        resultCode: 0,
        payload: { mediaBrowserInfo: { photos: [] } },
      });

    await harness.callTool('redfin_get_property_photos', {
      url: '/NY/Brooklyn/foo/home/1',
    });
    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(2);
    expect(mockFetchStingrayJson.mock.calls[0][0]).toMatch(/initialInfo/);
    expect(mockFetchStingrayJson.mock.calls[1][0]).toMatch(/aboveTheFold/);
  });

  it('returns count=0 when mediaBrowserInfo is empty (off-market property)', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {},
    });
    const r = await harness.callTool('redfin_get_property_photos', {
      property_id: 1,
      listing_id: 1,
    });
    const parsed = parseToolResult<{ count: number; photos: unknown[] }>(r);
    expect(parsed.count).toBe(0);
    expect(parsed.photos).toEqual([]);
  });

  it('returns canonical URL when called with IDs and ATF gives address', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        addressSectionInfo: {
          streetAddress: '158 Raven Blvd',
          city: 'Lake Lure',
          state: 'NC',
          zip: '28746',
        },
        mediaBrowserInfo: { photos: [] },
      },
    });
    const r = await harness.callTool('redfin_get_property_photos', {
      property_id: 112653221,
      listing_id: 99,
    });
    const parsed = parseToolResult<{ url: string }>(r);
    expect(parsed.url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221'
    );
  });
});
