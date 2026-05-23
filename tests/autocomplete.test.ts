import { describe, it, expect, vi } from 'vitest';
import type { RedfinClient } from '../src/client.js';
import { parseRegionId, resolveRegion } from '../src/autocomplete.js';

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
