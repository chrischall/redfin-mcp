import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import {
  extractFavoritePropertyIds,
  extractSavedSearches,
  formatHomeCard,
  parseAvailablePhotos,
  registerSavedTools,
} from '../../src/tools/saved.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockFetchStingrayJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchStingrayJson: mockFetchStingrayJson,
} as unknown as RedfinClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('extractFavoritePropertyIds', () => {
  it('extracts unique /home/<id> ids in order of first appearance', () => {
    const html = '<a href="/x/y/home/123">a</a> <a href="/p/home/456">b</a>';
    expect(extractFavoritePropertyIds(html)).toEqual([123, 456]);
  });

  it('dedupes repeated ids', () => {
    const html = '/home/100 /home/100 /home/200 /home/100';
    expect(extractFavoritePropertyIds(html)).toEqual([100, 200]);
  });

  it('returns [] when no /home/<id> matches', () => {
    expect(extractFavoritePropertyIds('<html>no favorites</html>')).toEqual([]);
  });
});

describe('formatHomeCard', () => {
  it('flattens a homecard into the user-facing shape', () => {
    const out = formatHomeCard({
      propertyId: 123,
      isFavorite: true,
      commonHomeData: {
        url: '/NC/Hendersonville/318-Cider-Hill-Ln-28792/home/123',
        status: { displayValue: 'Active' },
        priceInfo: { amount: 630000 },
        entireAddressString: '318 Cider Hill Ln, Hendersonville, NC 28792',
        city: 'Hendersonville',
        state: 'NC',
        zip: '28792',
        beds: 3,
        baths: 2,
        sqFt: { value: 1800 },
      },
    });
    expect(out).toEqual({
      property_id: 123,
      url: 'https://www.redfin.com/NC/Hendersonville/318-Cider-Hill-Ln-28792/home/123',
      status: 'Active',
      price: 630000,
      address: '318 Cider Hill Ln, Hendersonville, NC 28792',
      city: 'Hendersonville',
      state: 'NC',
      zip: '28792',
      beds: 3,
      baths: 2,
      sqft: 1800,
      is_favorite: true,
    });
  });

  it('returns null when propertyId is missing', () => {
    expect(formatHomeCard({})).toBeNull();
  });

  it('synthesizes a fallback URL when commonHomeData.url is missing', () => {
    const out = formatHomeCard({ propertyId: 7 });
    expect(out?.url).toBe('https://www.redfin.com/home/7');
  });

  it('builds image_url + thumbnail_url + photo_count from mlsId/dataSourceId/availablePhotos', () => {
    const out = formatHomeCard({
      propertyId: 1,
      commonHomeData: {
        url: '/x/home/1',
        mlsId: '2111124202183295849',
        dataSourceId: 641,
        availablePhotos: '0-20:0',
      },
    });
    expect(out?.image_url).toBe(
      'https://ssl.cdn-redfin.com/photo/641/bigphoto/849/2111124202183295849_0.jpg'
    );
    expect(out?.thumbnail_url).toBe(
      'https://ssl.cdn-redfin.com/photo/641/mbphotov3/849/genMid.2111124202183295849_0.jpg'
    );
    expect(out?.photo_count).toBe(21);
  });

  it('omits image_url when mlsId or dataSourceId is absent', () => {
    const out = formatHomeCard({
      propertyId: 1,
      commonHomeData: { dataSourceId: 641 },
    });
    expect(out?.image_url).toBeUndefined();
    expect(out?.thumbnail_url).toBeUndefined();
  });
});

describe('parseAvailablePhotos', () => {
  it('parses an inclusive range string into a total count', () => {
    expect(parseAvailablePhotos('0-20:0')).toBe(21);
    expect(parseAvailablePhotos('0-0:0')).toBe(1);
    expect(parseAvailablePhotos('5-9')).toBe(5);
  });

  it('returns undefined for missing or malformed input', () => {
    expect(parseAvailablePhotos(undefined)).toBeUndefined();
    expect(parseAvailablePhotos('')).toBeUndefined();
    expect(parseAvailablePhotos('garbage')).toBeUndefined();
    expect(parseAvailablePhotos('10-5:0')).toBeUndefined();
  });
});

describe('extractSavedSearches', () => {
  it('extracts region URLs with display text from anchor tags', () => {
    const html =
      '<a href="/city/30749/NY/New-York">New York Homes</a> <a href="/zipcode/11215">Park Slope</a>';
    const out = extractSavedSearches(html);
    expect(out).toEqual([
      {
        url: 'https://www.redfin.com/city/30749/NY/New-York',
        region_segment: '/city/30749/NY/New-York',
        display_text: 'New York Homes',
      },
      {
        url: 'https://www.redfin.com/zipcode/11215',
        region_segment: '/zipcode/11215',
        display_text: 'Park Slope',
      },
    ]);
  });

  it('dedupes by URL', () => {
    const html =
      '<a href="/city/1/X/Y">first</a> <a href="/city/1/X/Y">again</a>';
    expect(extractSavedSearches(html)).toHaveLength(1);
  });

  it('returns [] when no region-shape URLs are present', () => {
    expect(extractSavedSearches('<html>nothing here</html>')).toEqual([]);
  });
});

describe('redfin_get_saved_homes tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSavedTools(server, mockClient)
    );
  });

  it('fetches favorites HTML, extracts ids, calls homecards', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      '<a href="/x/y/home/100">a</a><a href="/p/home/200">b</a>'
    );
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        homecards: [
          {
            propertyId: 100,
            commonHomeData: {
              url: '/x/y/home/100',
              priceInfo: { amount: 500_000 },
              city: 'A',
              state: 'NY',
            },
          },
          {
            propertyId: 200,
            commonHomeData: {
              url: '/p/home/200',
              priceInfo: { amount: 800_000 },
              city: 'B',
              state: 'NY',
            },
          },
        ],
      },
    });

    const result = await harness.callTool('redfin_get_saved_homes', {});
    expect(result.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/myredfin/favorites');
    const cardPath = mockFetchStingrayJson.mock.calls[0][0] as string;
    expect(cardPath).toMatch(/favorites\/homecards\?b=100%2C200/);

    const parsed = parseToolResult<Array<{ property_id: number }>>(result);
    expect(parsed.map((h) => h.property_id)).toEqual([100, 200]);
  });

  /**
   * The regression tests/view.test.ts covers through the standalone
   * `viewResponse()` helper, re-run through the REAL tool: registerTool's
   * `inputSchema` (does it even accept `view`?), the handler's destructuring
   * (does it thread the arg through?), and the `viewResponse` call at the end.
   *
   * That wiring is exactly what a helper-level test cannot see. The suite had
   * 448 passing tests while compact was silently deleting `image_url` and
   * `thumbnail_url` from every saved-home record, because every homecard
   * fixture above leaves `mlsId`/`dataSourceId` unset and those two fields
   * therefore never appear. So this fixture sets them, and asserts on the
   * constructed URLs the caller would actually lose.
   */
  const cardWithPhotos = {
    propertyId: 300,
    isFavorite: true,
    commonHomeData: {
      url: '/x/y/home/300',
      priceInfo: { amount: 425_000 },
      city: 'Hendersonville',
      state: 'NC',
      mlsId: '2111124202183295849',
      dataSourceId: 641,
      availablePhotos: '0-20:0',
    },
  };
  const IMAGE_URL =
    'https://ssl.cdn-redfin.com/photo/641/bigphoto/849/2111124202183295849_0.jpg';
  const THUMBNAIL_URL =
    'https://ssl.cdn-redfin.com/photo/641/mbphotov3/849/genMid.2111124202183295849_0.jpg';

  const mockOneFavorite = () => {
    mockFetchHtml.mockResolvedValueOnce('<a href="/x/y/home/300">a</a>');
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { homecards: [cardWithPhotos] },
    });
  };

  it('keeps the constructed image_url/thumbnail_url on the DEFAULT (compact) view', async () => {
    mockOneFavorite();
    // No `view` argument at all — the rung a caller gets without asking, and
    // the one the regression shipped on.
    const result = await harness.callTool('redfin_get_saved_homes', {});
    expect(result.isError).toBeFalsy();
    const [home] = parseToolResult<
      Array<{ image_url?: string; thumbnail_url?: string; photo_count?: number }>
    >(result);
    expect(home.image_url).toBe(IMAGE_URL);
    expect(home.thumbnail_url).toBe(THUMBNAIL_URL);
    // `photo_count` is the caller's cue that redfin_get_property_photos has
    // more; it is a number, so no media rule should ever have reached it.
    expect(home.photo_count).toBe(21);
  });

  it('keeps them on an explicit compact too — the schema really accepts `view`', async () => {
    mockOneFavorite();
    // Naming the rung explicitly is the half a helper-level test cannot check:
    // if `view` were missing from `inputSchema`, the SDK would reject the call
    // outright rather than quietly ignoring the argument.
    const result = await harness.callTool('redfin_get_saved_homes', {
      view: 'compact',
    });
    expect(result.isError).toBeFalsy();
    const [home] = parseToolResult<Array<{ image_url?: string }>>(result);
    expect(home.image_url).toBe(IMAGE_URL);
  });

  it('full returns the same record untouched', async () => {
    mockOneFavorite();
    const result = await harness.callTool('redfin_get_saved_homes', {
      view: 'full',
    });
    const [home] = parseToolResult<
      Array<{ image_url?: string; thumbnail_url?: string }>
    >(result);
    expect(home.image_url).toBe(IMAGE_URL);
    expect(home.thumbnail_url).toBe(THUMBNAIL_URL);
  });

  it('emits minified JSON — no formatting whitespace of its own', async () => {
    mockOneFavorite();
    const result = await harness.callTool('redfin_get_saved_homes', {});
    // One line means no indent. The PR's whole size win is this, and it is
    // only observable on the serialized text, not on the parsed object.
    expect((result.content as Array<{ text: string }>)[0].text.split('\n')).toHaveLength(1);
  });

  it('returns [] without calling homecards when user has no favorites', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no favorites yet</html>');
    const result = await harness.callTool('redfin_get_saved_homes', {});
    expect(parseToolResult(result)).toEqual([]);
    expect(mockFetchStingrayJson).not.toHaveBeenCalled();
  });
});

describe('redfin_get_saved_searches tool', () => {
  it('fetches and extracts saved-search entries from the page HTML', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      '<a href="/city/30749/NY/New-York">NY Homes</a>'
    );
    const result = await harness.callTool('redfin_get_saved_searches', {});
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/myredfin/saved-searches');
    const parsed = parseToolResult<Array<{ region_segment: string }>>(result);
    expect(parsed[0].region_segment).toBe('/city/30749/NY/New-York');
  });

  it('returns [] when no region-shape URLs found', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no saved</html>');
    const result = await harness.callTool('redfin_get_saved_searches', {});
    expect(parseToolResult(result)).toEqual([]);
  });
});
