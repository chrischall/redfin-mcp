import { describe, it, expect, vi } from 'vitest';
import type { RedfinClient } from '../src/client.js';
import {
  parseAddressUrl,
  parseRegionId,
  resolveAddress,
  resolveBoth,
  resolveRegion,
} from '../src/autocomplete.js';

describe('parseRegionId', () => {
  it('parses "TYPE_REGIONID"', () => {
    expect(parseRegionId('6_30749')).toEqual({
      region_type: 6,
      region_id: 30749,
    });
  });
  it('returns null for malformed input', () => {
    expect(parseRegionId('not-an-id')).toBeNull();
    expect(parseRegionId(undefined)).toBeNull();
    expect(parseRegionId('6')).toBeNull();
  });
});

describe('resolveRegion', () => {
  const mockFetchStingrayJson = vi.fn();
  const mockClient = {
    fetchStingrayJson: mockFetchStingrayJson,
  } as unknown as RedfinClient;

  it('returns the first Places row, parsed', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Places',
            rows: [
              {
                id: '6_30749',
                name: 'New York',
                subName: 'New York, NY, USA',
                url: '/city/30749/NY/New-York',
              },
            ],
          },
          { name: 'Schools', rows: [{ id: '27_1' }] },
        ],
      },
    });
    const r = await resolveRegion(mockClient, 'NYC');
    expect(r).toEqual({
      region_id: 30749,
      region_type: 6,
      name: 'New York',
      sub_name: 'New York, NY, USA',
      url: '/city/30749/NY/New-York',
    });
  });

  it('returns null when no Places section is present', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { sections: [{ name: 'Schools', rows: [{ id: '27_1' }] }] },
    });
    expect(await resolveRegion(mockClient, 'NYC')).toBeNull();
  });

  it('returns null when Places section is empty', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { sections: [{ name: 'Places', rows: [] }] },
    });
    expect(await resolveRegion(mockClient, 'nonexistent')).toBeNull();
  });

  it('returns null when the top Places row has a malformed id', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { sections: [{ name: 'Places', rows: [{ id: 'bad', name: 'X' }] }] },
    });
    expect(await resolveRegion(mockClient, 'NYC')).toBeNull();
  });
});

describe('parseAddressUrl', () => {
  it('extracts state/city/street-slug/zip/home_id from a canonical address URL', () => {
    expect(
      parseAddressUrl(
        '/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221'
      )
    ).toEqual({
      state: 'NC',
      city: 'Lake Lure',
      street: '158 Raven Blvd',
      zip: '28746',
      home_id: '112653221',
    });
  });

  it('handles a unit segment (e.g. /unit-C/)', () => {
    expect(
      parseAddressUrl(
        '/WA/Seattle/9243-35th-Ave-SW-98126/unit-C/home/18659204'
      )
    ).toMatchObject({
      state: 'WA',
      city: 'Seattle',
      zip: '98126',
      home_id: '18659204',
    });
  });

  it('returns null for non-address URLs', () => {
    expect(parseAddressUrl('/city/30749/NY/New-York')).toBeNull();
    expect(parseAddressUrl('/zipcode/28746')).toBeNull();
    expect(parseAddressUrl('not-a-url')).toBeNull();
  });

  it('returns null when the home id is missing', () => {
    expect(parseAddressUrl('/NC/Lake-Lure/158-Raven-Blvd-28746/')).toBeNull();
  });
});

describe('resolveAddress', () => {
  const mockFetchStingrayJson = vi.fn();
  const mockClient = {
    fetchStingrayJson: mockFetchStingrayJson,
  } as unknown as RedfinClient;

  it('returns the first Addresses row, parsed', async () => {
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
              },
            ],
          },
        ],
      },
    });
    const r = await resolveAddress(mockClient, '158 Raven Blvd Lake Lure NC');
    expect(r).toEqual({
      home_id: '112653221',
      url: 'https://www.redfin.com/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221',
      path: '/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221',
      street_address: '158 Raven Blvd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
  });

  it('returns null when no Addresses section is present', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [{ name: 'Places', rows: [{ id: '6_30749' }] }],
      },
    });
    expect(await resolveAddress(mockClient, 'NYC')).toBeNull();
  });

  it('returns null when the Addresses section is empty', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { sections: [{ name: 'Addresses', rows: [] }] },
    });
    expect(await resolveAddress(mockClient, 'nowhere')).toBeNull();
  });

  it('returns null when the first Addresses row has an unparseable URL', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [{ name: 'foo', url: '/not-an-address-url' }],
          },
        ],
      },
    });
    expect(await resolveAddress(mockClient, 'foo')).toBeNull();
  });

  it('AUDIT 1.B2: rejects a fuzzy autocomplete WRONG-HOUSE row — returned house number differs from the query', async () => {
    // Redfin's autocomplete is fuzzy: a query for 158 can surface the
    // neighbor at 160 as rows[0]. Accepting it blind resolves the wrong
    // house. The addressMatch gate must reject it.
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '160 Raven Blvd',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/160-Raven-Blvd-28746/home/999',
              },
            ],
          },
        ],
      },
    });
    expect(
      await resolveAddress(mockClient, '158 Raven Blvd Lake Lure NC 28746')
    ).toBeNull();
  });

  it('AUDIT 1.B2: rejects a fuzzy autocomplete near-miss on a DIFFERENT street, even with the same house number', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '158 Raccoon Rd',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/158-Raccoon-Rd-28746/home/998',
              },
            ],
          },
        ],
      },
    });
    expect(
      await resolveAddress(mockClient, '158 Raven Blvd Lake Lure NC 28746')
    ).toBeNull();
  });

  it('still resolves when the returned street uses a suffix variant of the query (Rd vs Road)', async () => {
    // The gate must not regress the issue #43 class: suffix drift between
    // the query and the canonical row is fine — same house, same street.
    mockFetchStingrayJson.mockResolvedValueOnce({
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
              },
            ],
          },
        ],
      },
    });
    const r = await resolveAddress(
      mockClient,
      '268 Mallard Rd Lake Lure NC 28746'
    );
    expect(r?.home_id).toBe('12345');
  });
});

describe('resolveBoth', () => {
  const mockFetchStingrayJson = vi.fn();
  const mockClient = {
    fetchStingrayJson: mockFetchStingrayJson,
  } as unknown as RedfinClient;

  it('AUDIT 1.B2: applies the same wrong-house gate as resolveAddress (search profile_only path)', async () => {
    // Fuzzy autocomplete returns the neighbor at 160 for a 158 query, plus a
    // Places row. The address must be rejected; the region must survive.
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Places',
            rows: [{ id: '6_12345', name: 'Lake Lure, NC', url: '/city/12345' }],
          },
          {
            name: 'Addresses',
            rows: [
              {
                name: '160 Raven Blvd',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/160-Raven-Blvd-28746/home/999',
              },
            ],
          },
        ],
      },
    });
    const r = await resolveBoth(mockClient, '158 Raven Blvd Lake Lure NC');
    expect(r.address).toBeNull();
    expect(r.region?.region_id).toBe(12345);
  });

  it('returns a genuinely matching Addresses row alongside the region', async () => {
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
              },
            ],
          },
        ],
      },
    });
    const r = await resolveBoth(mockClient, '158 Raven Blvd Lake Lure NC');
    expect(r.address?.home_id).toBe('112653221');
  });
});
