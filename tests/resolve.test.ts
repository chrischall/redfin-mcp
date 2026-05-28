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
    // No variant resolves — the ladder should walk all of them and
    // return `match: null` with `matchedVariant` undefined.
    mockFetchStingrayJson.mockResolvedValue(emptyAddressesResponse);

    const result = await resolveAddressWithFallbacks(mockClient, {
      street: '0 Nowhere Ln',
      city: 'Nowhere',
      state: 'NC',
      zip: '99999',
    });

    expect(mockFetchStingrayJson).toHaveBeenCalledTimes(2);
    expect(result.match).toBeNull();
    expect(result.matchedVariant).toBeUndefined();
    expect(result.attempts).toEqual([
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
});
