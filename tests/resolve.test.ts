/**
 * Direct unit tests for `src/resolve.ts`. The two exported helpers
 * (`buildVariants`, `resolveAddressWithFallbacks`) drive the
 * address-resolution rung ladder shared by both `redfin_get_by_address`
 * (single) and `redfin_resolve_addresses` (bulk). They've historically
 * been covered only indirectly via the tool-level tests; this file
 * fills that gap so future refactors can rely on direct unit signal
 * rather than reading tool-level fixtures backwards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RedfinClient } from '../src/client.js';
import {
  buildVariants,
  createLocalityPoolCache,
  resolveAddressWithFallbacks,
} from '../src/resolve.js';

describe('buildVariants', () => {
  it('returns two variants when the street has a swappable suffix', () => {
    // Sanity: the canonical regression case (issue #43) — the
    // as-typed form first, the suffix-expansion variant second.
    const variants = buildVariants({
      street: '268 Mallard Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(variants).toEqual([
      '268 Mallard Rd Lake Lure NC 28746',
      '268 Mallard Road Lake Lure NC 28746',
    ]);
  });

  it('dedupes when a suffix swap is a no-op (Way ↔ Way identity row)', () => {
    // `Way` is in the suffix table as an identity pair so the lookup
    // is exhaustive — but the expansion candidate equals the input,
    // so buildVariants must collapse to a single one-rung walk.
    const variants = buildVariants({
      street: '12 Highland Way',
      city: 'Asheville',
      state: 'NC',
      zip: '28804',
    });
    expect(variants).toEqual(['12 Highland Way Asheville NC 28804']);
    expect(variants).toHaveLength(1);
  });

  it('dedupes when a swap produces no change without any city/state/zip suffix', () => {
    // Same dedup path, but the all-optional-omitted case: the
    // candidate is the bare street so we have to confirm the seen-set
    // logic still fires (and does not produce two identical entries).
    const variants = buildVariants({ street: '12 Highland Way' });
    expect(variants).toEqual(['12 Highland Way']);
  });

  describe('cityStateZip join with various optional-field combinations', () => {
    it('joins all four parts when present', () => {
      const variants = buildVariants({
        street: '158 Raven Blvd',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      expect(variants[0]).toBe('158 Raven Blvd Lake Lure NC 28746');
    });

    it('omits city/state/zip suffix entirely when none provided', () => {
      const variants = buildVariants({ street: '158 Raven Blvd' });
      expect(variants[0]).toBe('158 Raven Blvd');
    });

    it('joins only the parts that are present (zip only)', () => {
      const variants = buildVariants({ street: '158 Raven Blvd', zip: '28746' });
      expect(variants[0]).toBe('158 Raven Blvd 28746');
    });

    it('joins only the parts that are present (city + state)', () => {
      const variants = buildVariants({
        street: '158 Raven Blvd',
        city: 'Lake Lure',
        state: 'NC',
      });
      expect(variants[0]).toBe('158 Raven Blvd Lake Lure NC');
    });

    it('treats whitespace-only optional fields as empty', () => {
      // The filter predicate is `Boolean(s && s.trim())` — a value of
      // "   " should be dropped, not joined as a literal block of spaces.
      const variants = buildVariants({
        street: '158 Raven Blvd',
        city: '   ',
        state: 'NC',
        zip: '',
      });
      expect(variants[0]).toBe('158 Raven Blvd NC');
    });
  });

  it('zero-variants edge case — empty street', () => {
    // `expandAddressVariants('')` returns no candidates, so the
    // forEach body never runs and buildVariants returns []. The
    // ladder walk in `resolveAddressWithFallbacks` must then make zero
    // upstream calls.
    expect(buildVariants({ street: '' })).toEqual([]);
    expect(
      buildVariants({ street: '', city: 'Lake Lure', state: 'NC' })
    ).toEqual([]);
  });
});

describe('resolveAddressWithFallbacks', () => {
  const mockFetchStingrayJson = vi.fn();
  const mockClient = {
    fetchStingrayJson: mockFetchStingrayJson,
  } as unknown as RedfinClient;

  beforeEach(() => vi.clearAllMocks());

  // Pull the query out of the autocomplete path the same way the
  // existing tool-level tests do (URLSearchParams encodes ' ' as '+').
  const queryOf = (path: string): string =>
    decodeURIComponent(
      (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
    );

  const emptyAddressesResponse = {
    resultCode: 0,
    payload: { sections: [{ name: 'Addresses', rows: [] }] },
  };

  it('walks the ladder — first variant misses, second hits', async () => {
    // The canonical #43 regression at the resolver level: input as-typed
    // ("Rd") misses Redfin's autocomplete; the suffix-expansion variant
    // ("Road") hits on the second rung. Verifies the resolver actually
    // calls past the first attempt.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      const q = queryOf(path);
      if (q.includes('Mallard Road')) {
        return {
          resultCode: 0,
          payload: {
            sections: [
              {
                name: 'Addresses',
                rows: [
                  {
                    name: '268 Mallard Road',
                    subName: 'Lake Lure, NC 28746',
                    url: '/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345',
                    id: '12345',
                  },
                ],
              },
            ],
          },
        };
      }
      return emptyAddressesResponse;
    });

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '268 Mallard Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(2);
    expect(result.match).not.toBeNull();
    expect(result.match?.home_id).toBe('12345');
    expect(result.matchedVariant).toBe(
      '268 Mallard Road Lake Lure NC 28746'
    );
    // attempts records every variant tried, in order.
    expect(result.attempts).toEqual([
      '268 Mallard Rd Lake Lure NC 28746',
      '268 Mallard Road Lake Lure NC 28746',
    ]);
  });

  it('returns null match and full attempts list when every rung misses', async () => {
    // No variant resolves — the ladder should walk both autocomplete
    // variants AND the search-fallback rung's region-resolution call,
    // and return `match: null` with `matchedVariant` undefined. With
    // locality info present the search-fallback rung will attempt
    // region resolution (one extra autocomplete call), so the total
    // is 3: autocomplete x2 (address variants) + autocomplete x1
    // (region resolution that itself misses).
    mockFetchStingrayJson.mockResolvedValue(emptyAddressesResponse);

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '0 Nowhere Ln',
      city: 'Nowhere',
      state: 'NC',
      zip: '99999',
    });

    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(3);
    expect(result.match).toBeNull();
    expect(result.matchedVariant).toBeUndefined();
    // First two are address attempts; third is the search-fallback marker.
    expect(result.attempts.slice(0, 2)).toEqual([
      '0 Nowhere Ln Nowhere NC 99999',
      '0 Nowhere Lane Nowhere NC 99999',
    ]);
  });

  it('stops on the first hit — does not call past the matched variant', async () => {
    // The first rung resolves; the resolver must not make a second
    // upstream call. (If you ever swap the early-return for a forEach,
    // this test will catch it.)
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '158 Raven Blvd',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221',
                id: '112653221',
              },
            ],
          },
        ],
      },
    });

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '158 Raven Blvd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(1);
    expect(result.match?.home_id).toBe('112653221');
    expect(result.matchedVariant).toBe('158 Raven Blvd Lake Lure NC 28746');
    expect(result.attempts).toEqual([
      '158 Raven Blvd Lake Lure NC 28746',
    ]);
  });

  it('zero variants — makes no upstream calls and returns null', async () => {
    // The empty-street edge case from buildVariants: zero candidates,
    // so the for-loop body never runs and the resolver returns null
    // with an empty attempts list. Importantly, this means no upstream
    // network call — useful for callers that batch.
    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '',
    });
    expect(mockFetchStingrayJson).not.toHaveBeenCalled();
    expect(result).toEqual({ match: null, attempts: [] });
  });

  it('reports matched_via: "autocomplete" when an autocomplete rung hits', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '158 Raven Blvd',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221',
                id: '112653221',
              },
            ],
          },
        ],
      },
    });

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '158 Raven Blvd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(result.matchedVia).toBe('autocomplete');
  });
});

// ---------------------------------------------------------------------
// Search-fallback rung (#75)
//
// When every autocomplete variant misses, fall through to a gis search
// bounded by `{city, state}` (or `{zip}`), reuse `assertRegionMatches`
// guards, and fuzzy-match returned homes against the input street's
// tokens (suffix-expansion-aware). Returns a synthetic `RedfinAddress`
// for the matched home and tags `matched_via: 'search_fallback'`.
// ---------------------------------------------------------------------
describe('resolveAddressWithFallbacks — search-fallback rung (#75)', () => {
  const mockFetchStingrayJson = vi.fn();
  const mockClient = {
    fetchStingrayJson: mockFetchStingrayJson,
  } as unknown as RedfinClient;

  beforeEach(() => vi.clearAllMocks());

  const emptyAddressesResponse = {
    resultCode: 0,
    payload: { sections: [{ name: 'Addresses', rows: [] }] },
  };

  /** Build an autocomplete payload that resolves a Places region. */
  const placesPayload = (region_id: number, name: string, sub: string) => ({
    resultCode: 0,
    payload: {
      sections: [
        {
          name: 'Places',
          rows: [
            {
              id: `2_${region_id}`,
              name,
              subName: sub,
              url: `/city/${region_id}/NC/${name.replace(/ /g, '-')}`,
            },
          ],
        },
      ],
    },
  });

  /** Build a gis search response with the given home rows. */
  const gisPayload = (
    homes: Array<{
      propertyId: number;
      url: string;
      streetLine: string;
      city: string;
      state: string;
      zip: string;
    }>,
    serviceRegionName = 'Lake-Lure'
  ) => ({
    resultCode: 0,
    payload: {
      serviceRegionName,
      homes: homes.map((h) => ({
        propertyId: h.propertyId,
        url: h.url,
        streetLine: { value: h.streetLine },
        city: h.city,
        state: h.state,
        zip: h.zip,
      })),
    },
  });

  it('falls back to gis search when autocomplete misses and gis returns a single matching hit', async () => {
    // 1) Autocomplete (input) → empty
    // 2) Autocomplete (suffix-expansion) → empty
    // 3) resolveRegion for "Lake Lure NC" → Places hit (region 2_555)
    // 4) gis search bounded to that region → ONE home with matching tokens
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        // Region-resolution query is just "city state" (no street).
        if (q === 'Lake Lure NC') {
          return placesPayload(555, 'Lake Lure', 'NC, USA');
        }
        // All address queries miss.
        return emptyAddressesResponse;
      }
      if (path.startsWith('/stingray/api/gis')) {
        return gisPayload([
          {
            propertyId: 99001,
            url: '/NC/Lake-Lure/212-Ridgeway-Rd-28746/home/99001',
            streetLine: '212 Ridgeway Rd',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '212 Ridgeway Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    expect(result.match).not.toBeNull();
    expect(result.match?.home_id).toBe('99001');
    expect(result.matchedVia).toBe('search_fallback');
    // Attempts records both rungs (autocomplete + search-fallback marker).
    expect(result.attempts.length).toBeGreaterThanOrEqual(2);
  });

  it('fuzzy-matches the right home when gis returns multiple hits — street-token equality picks the winner', async () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (q === 'Lake Lure NC') {
          return placesPayload(555, 'Lake Lure', 'NC, USA');
        }
        return emptyAddressesResponse;
      }
      if (path.startsWith('/stingray/api/gis')) {
        return gisPayload([
          {
            propertyId: 1,
            url: '/NC/Lake-Lure/100-Oakwood-Dr-28746/home/1',
            streetLine: '100 Oakwood Dr',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
          {
            propertyId: 2,
            url: '/NC/Lake-Lure/231-Bluebird-Rd-28746/home/2',
            streetLine: '231 Bluebird Rd',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
          {
            propertyId: 3,
            url: '/NC/Lake-Lure/50-Other-Way-28746/home/3',
            streetLine: '50 Other Way',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '231 Bluebird Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    expect(result.match?.home_id).toBe('2');
    expect(result.matchedVia).toBe('search_fallback');
  });

  it('fuzzy-match is suffix-expansion-aware — "Highland Heights" matches a gis row of "Highland Heights" regardless of trailing suffix variant', async () => {
    // Input has no suffix token; gis returns "Highland Heights"
    // (which has a number prefix and no suffix). The token-equality
    // matcher must still pick it up after suffix-expansion normalization.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (q === 'Lake Lure NC') {
          return placesPayload(555, 'Lake Lure', 'NC, USA');
        }
        return emptyAddressesResponse;
      }
      if (path.startsWith('/stingray/api/gis')) {
        return gisPayload([
          {
            propertyId: 42,
            url: '/NC/Lake-Lure/181-Highland-Heights-28746/home/42',
            streetLine: '181 Highland Heights',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '181 Highland Heights',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    expect(result.match?.home_id).toBe('42');
    expect(result.matchedVia).toBe('search_fallback');
  });

  it('returns null when region resolution fails (city/state not found in Places)', async () => {
    // Autocomplete misses on the address. The region-resolution query
    // (city + state) also returns no Places row → the search-fallback
    // rung cannot proceed and the resolver returns match: null.
    mockFetchStingrayJson.mockResolvedValue(emptyAddressesResponse);

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '999 Bogus Way',
      city: 'Notarealcity',
      state: 'NC',
      zip: '99999',
    });

    expect(result.match).toBeNull();
    expect(result.matchedVia).toBeUndefined();
  });

  it('does not run search fallback when neither city/state nor zip are provided', async () => {
    // Without any locality info we have nothing to bound the search by,
    // so the search-fallback rung must be skipped — match stays null
    // and only autocomplete calls fire.
    mockFetchStingrayJson.mockResolvedValue(emptyAddressesResponse);

    await resolveAddressWithFallbacks(mockClient, {
      street: '999 Bogus Way',
    });

    for (const call of mockFetchStingrayJson.mock.calls) {
      expect(call[0]).not.toMatch(/\/stingray\/api\/gis/);
    }
  });

  it('returns null when gis returns no homes matching the street tokens', async () => {
    // Region resolves cleanly + gis returns unrelated homes → no match.
    // No false-positive on first-row even though region resolution succeeded.
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (q === 'Lake Lure NC') {
          return placesPayload(555, 'Lake Lure', 'NC, USA');
        }
        return emptyAddressesResponse;
      }
      if (path.startsWith('/stingray/api/gis')) {
        return gisPayload([
          {
            propertyId: 9,
            url: '/NC/Lake-Lure/1-Different-Rd-28746/home/9',
            streetLine: '1 Different Rd',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '212 Ridgeway Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    expect(result.match).toBeNull();
  });

  it("propagates assertRegionMatches errors — does NOT silently swallow Redfin's cross-continent fallback", async () => {
    // Reuse the existing silent-fallback guard. If gis returns
    // home rows from a state that disagrees with the ZIP we passed,
    // the rung must surface the assertion error (not eat it and
    // degrade to resolved=false).
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (q.includes('Lake Lure')) {
          return placesPayload(555, 'Lake Lure', 'NC, USA');
        }
        return emptyAddressesResponse;
      }
      if (path.startsWith('/stingray/api/gis')) {
        // ZIP 28746 → NC, but gis returned WA homes (the canonical #46 case).
        return gisPayload(
          [
            {
              propertyId: 1,
              url: '/WA/Seattle/100-Fremont-Ave-98103/home/1',
              streetLine: '100 Fremont Ave',
              city: 'Seattle',
              state: 'WA',
              zip: '98103',
            },
          ],
          'Seattle'
        );
      }
      throw new Error(`unexpected path ${path}`);
    });

    await expect(
      resolveAddressWithFallbacks(mockClient, {
        street: '212 Ridgeway Rd',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      })
    ).rejects.toThrow(/ZIP 28746/);
  });
});

// ---------------------------------------------------------------------
// Per-locality pool cache (batch memoization)
//
// Batch address resolution re-ran `resolveRegion` + the ~350-home gis
// search per row. When many rows share a locality, that's N redundant
// region lookups + N gis pulls. `createLocalityPoolCache()` memoizes the
// region+gis pool keyed on the locality query so a same-city batch does
// one region lookup + one gis pull total. Per-row street-token scoring
// still runs locally against the shared pool.
// ---------------------------------------------------------------------
describe('resolveAddressWithFallbacks — per-locality pool cache', () => {
  const mockFetchStingrayJson = vi.fn();
  const mockClient = {
    fetchStingrayJson: mockFetchStingrayJson,
  } as unknown as RedfinClient;

  beforeEach(() => vi.clearAllMocks());

  const emptyAddressesResponse = {
    resultCode: 0,
    payload: { sections: [{ name: 'Addresses', rows: [] }] },
  };

  const placesPayload = (region_id: number, name: string, sub: string) => ({
    resultCode: 0,
    payload: {
      sections: [
        {
          name: 'Places',
          rows: [
            {
              id: `2_${region_id}`,
              name,
              subName: sub,
              url: `/city/${region_id}/NC/${name.replace(/ /g, '-')}`,
            },
          ],
        },
      ],
    },
  });

  const gisPayload = (
    homes: Array<{
      propertyId: number;
      url: string;
      streetLine: string;
      city: string;
      state: string;
      zip: string;
    }>,
    serviceRegionName = 'Lake-Lure'
  ) => ({
    resultCode: 0,
    payload: {
      serviceRegionName,
      homes: homes.map((h) => ({
        propertyId: h.propertyId,
        url: h.url,
        streetLine: { value: h.streetLine },
        city: h.city,
        state: h.state,
        zip: h.zip,
      })),
    },
  });

  /** Wire up a mock where every address query misses autocomplete, the
   *  region query resolves, and the gis pull returns two distinct homes. */
  const wireSharedLocality = () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (q === 'Lake Lure NC') {
          return placesPayload(555, 'Lake Lure', 'NC, USA');
        }
        return emptyAddressesResponse;
      }
      if (path.startsWith('/stingray/api/gis')) {
        return gisPayload([
          {
            propertyId: 1,
            url: '/NC/Lake-Lure/100-Oakwood-Dr-28746/home/1',
            streetLine: '100 Oakwood Dr',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
          {
            propertyId: 2,
            url: '/NC/Lake-Lure/231-Bluebird-Rd-28746/home/2',
            streetLine: '231 Bluebird Rd',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });
  };

  const countCalls = (matcher: RegExp): number =>
    mockFetchStingrayJson.mock.calls.filter((c) => matcher.test(c[0] as string))
      .length;

  it('memoizes the region lookup + gis pull across same-locality rows', async () => {
    wireSharedLocality();
    const pool = createLocalityPoolCache();

    // Two rows in the same city; both miss autocomplete and fall through
    // to the search-fallback rung. The region resolve ("Lake Lure NC")
    // and the gis pull must each happen exactly ONCE despite two rows.
    const first = await resolveAddressWithFallbacks(
      mockClient,
      { street: '100 Oakwood Dr', city: 'Lake Lure', state: 'NC', zip: '28746' },
      { pool }
    );
    const second = await resolveAddressWithFallbacks(
      mockClient,
      { street: '231 Bluebird Rd', city: 'Lake Lure', state: 'NC', zip: '28746' },
      { pool }
    );

    expect(first.match?.home_id).toBe('1');
    expect(second.match?.home_id).toBe('2');
    expect(first.matchedVia).toBe('search_fallback');
    expect(second.matchedVia).toBe('search_fallback');

    // Region resolution is the "Lake Lure NC" autocomplete call; with the
    // pool cache it fires once, not once-per-row.
    const regionCalls = mockFetchStingrayJson.mock.calls.filter((c) => {
      const p = c[0] as string;
      if (!p.startsWith('/stingray/do/location-autocomplete')) return false;
      const q = decodeURIComponent(
        (/location=([^&]+)/.exec(p)?.[1] ?? '').replace(/\+/g, ' ')
      );
      return q === 'Lake Lure NC';
    }).length;
    expect(regionCalls).toBe(1);
    // The expensive gis pull also fires exactly once.
    expect(countCalls(/\/stingray\/api\/gis/)).toBe(1);
  });

  it('without a shared pool, each row re-runs the region lookup + gis pull', async () => {
    // Control: same two rows but NO pool — confirms the memoization is
    // what collapses the calls, not some other dedup.
    wireSharedLocality();

    await resolveAddressWithFallbacks(mockClient, {
      street: '100 Oakwood Dr',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    await resolveAddressWithFallbacks(mockClient, {
      street: '231 Bluebird Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    expect(countCalls(/\/stingray\/api\/gis/)).toBe(2);
  });

  it('keys the pool per distinct locality — different cities each pull once', async () => {
    mockFetchStingrayJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/stingray/do/location-autocomplete')) {
        const q = decodeURIComponent(
          (/location=([^&]+)/.exec(path)?.[1] ?? '').replace(/\+/g, ' ')
        );
        if (q === 'Lake Lure NC') return placesPayload(555, 'Lake Lure', 'NC');
        if (q === 'Asheville NC') return placesPayload(777, 'Asheville', 'NC');
        return emptyAddressesResponse;
      }
      if (path.startsWith('/stingray/api/gis')) {
        // Region id appears in the gis path; key the home off it.
        const isAsheville = /region_id=777/.test(path);
        return gisPayload([
          {
            propertyId: isAsheville ? 77 : 55,
            url: isAsheville
              ? '/NC/Asheville/9-Pine-St-28801/home/77'
              : '/NC/Lake-Lure/9-Pine-St-28746/home/55',
            streetLine: '9 Pine St',
            city: isAsheville ? 'Asheville' : 'Lake Lure',
            state: 'NC',
            zip: isAsheville ? '28801' : '28746',
          },
        ], isAsheville ? 'Asheville' : 'Lake-Lure');
      }
      throw new Error(`unexpected path ${path}`);
    });

    const pool = createLocalityPoolCache();
    const a = await resolveAddressWithFallbacks(
      mockClient,
      { street: '9 Pine St', city: 'Lake Lure', state: 'NC', zip: '28746' },
      { pool }
    );
    const b = await resolveAddressWithFallbacks(
      mockClient,
      { street: '9 Pine St', city: 'Asheville', state: 'NC', zip: '28801' },
      { pool }
    );

    expect(a.match?.home_id).toBe('55');
    expect(b.match?.home_id).toBe('77');
    // Two distinct localities → two gis pulls (one each, not cross-shared).
    expect(countCalls(/\/stingray\/api\/gis/)).toBe(2);
  });

  it('memoizes a region MISS too — a dead locality is not re-queried', async () => {
    mockFetchStingrayJson.mockResolvedValue(emptyAddressesResponse);
    const pool = createLocalityPoolCache();

    await resolveAddressWithFallbacks(
      mockClient,
      { street: '1 Nowhere Ln', city: 'Nowhere', state: 'NC', zip: '99999' },
      { pool }
    );
    const callsAfterFirst = mockFetchStingrayJson.mock.calls.length;
    await resolveAddressWithFallbacks(
      mockClient,
      { street: '2 Nowhere Ln', city: 'Nowhere', state: 'NC', zip: '99999' },
      { pool }
    );
    // The region-resolution call for "Nowhere NC" must be cached as a
    // miss — the second row only spends its own autocomplete attempts.
    const regionMissCalls = mockFetchStingrayJson.mock.calls.filter((c) => {
      const p = c[0] as string;
      const q = decodeURIComponent(
        (/location=([^&]+)/.exec(p)?.[1] ?? '').replace(/\+/g, ' ')
      );
      return q === 'Nowhere NC';
    }).length;
    expect(regionMissCalls).toBe(1);
    // Second row's extra calls are only its two address-variant attempts.
    expect(mockFetchStingrayJson.mock.calls.length).toBe(callsAfterFirst + 2);
  });
});
