import { describe, it, expect, vi } from 'vitest';
import type { RedfinClient } from '../src/client.js';
import {
  parseAddressUrl,
  parseRegionId,
  resolveAddress,
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
});
