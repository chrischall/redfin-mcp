import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import { registerGetByAddressTools } from '../../src/tools/get-by-address.js';
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

describe('redfin_get_by_address tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerGetByAddressTools(server, mockClient)
    );
  });

  it('resolves 158 Raven Blvd via autocomplete Addresses section', async () => {
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

    const result = await harness.callTool('redfin_get_by_address', {
      address: '158 Raven Blvd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(result.isError).toBeFalsy();

    const callPath = mockFetchStingrayJson.mock.calls[0][0] as string;
    expect(callPath).toMatch(/location-autocomplete\?/);
    // Must include the full address joined into a single query.
    expect(callPath).toMatch(/location=158\+Raven\+Blvd/);
    expect(callPath).toMatch(/Lake\+Lure/);
    expect(callPath).toMatch(/28746/);

    const parsed = parseToolResult<{
      resolved: boolean;
      url: string;
      home_id: string;
      street_address: string;
      city: string;
      state: string;
      zip: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221'
    );
    expect(parsed.home_id).toBe('112653221');
    expect(parsed.street_address).toBe('158 Raven Blvd');
    expect(parsed.city).toBe('Lake Lure');
    expect(parsed.state).toBe('NC');
    expect(parsed.zip).toBe('28746');
  });

  it('resolves 102 Havnaers Point in Lake Lure', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Addresses',
            rows: [
              {
                name: '102 Havnaers Point',
                subName: 'Lake Lure, NC 28746',
                url: '/NC/Lake-Lure/102-Havnaers-Point-28746/home/112682721',
              },
            ],
          },
        ],
      },
    });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '102 Havnaers Point',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });

    const parsed = parseToolResult<{
      resolved: boolean;
      home_id: string;
      url: string;
    }>(result);
    expect(parsed.resolved).toBe(true);
    expect(parsed.home_id).toBe('112682721');
    expect(parsed.url).toBe(
      'https://www.redfin.com/NC/Lake-Lure/102-Havnaers-Point-28746/home/112682721'
    );
  });

  it('degrades to resolved=false when no Addresses match', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: {
        sections: [
          {
            name: 'Places',
            rows: [{ id: '6_30749', name: 'New York' }],
          },
        ],
      },
    });

    const result = await harness.callTool('redfin_get_by_address', {
      address: '999 Nonexistent Way',
      city: 'Nowhere',
      state: 'NC',
      zip: '99999',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{ resolved: boolean; url?: string }>(result);
    expect(parsed.resolved).toBe(false);
    expect(parsed.url).toBeUndefined();
  });

  it('accepts minimal input (just address) and still hits autocomplete', async () => {
    mockFetchStingrayJson.mockResolvedValueOnce({
      resultCode: 0,
      payload: { sections: [{ name: 'Addresses', rows: [] }] },
    });
    const result = await harness.callTool('redfin_get_by_address', {
      address: '158 Raven Blvd Lake Lure NC 28746',
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{ resolved: boolean }>(result);
    expect(parsed.resolved).toBe(false);
    const callPath = mockFetchStingrayJson.mock.calls[0][0] as string;
    expect(callPath).toMatch(/location=158\+Raven\+Blvd\+Lake\+Lure\+NC\+28746/);
  });
});
