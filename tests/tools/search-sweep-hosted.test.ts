// redfin_sweep_area's output_path on a HOSTED deployment (mcp-host). The
// caller shares no filesystem with the server, so a file written to the
// runner's disk is unreachable: the full result set goes into a zip in the
// blob store instead, and the tool returns a signed link. Locally nothing
// changes (tests/tools/search-sweep.test.ts pins the disk path).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { RedfinClient } from '../../src/client.js';
import { sweepRedfinArea, sweepRedfinZips, type RawHome } from '../../src/tools/search.js';

const BASE = 'https://host.example/b/reg_0123456789abcdef01234567';

const fetchStingrayJson = vi.fn();
const client = { fetchStingrayJson } as unknown as RedfinClient;
const box = { north: 37.4, south: 37.2, east: -121.8, west: -122.0 };

function home(id: number, price: number, zip = '90001'): RawHome {
  return { propertyId: id, price: { value: price }, beds: 3, baths: 2, uiPropertyType: 1, city: 'Exampleville', state: 'CA', zip, latLong: { value: { latitude: 37.3, longitude: -121.9 } }, mlsStatus: 'Active' };
}

let outRoot: string;
let puts: Array<{ url: string; type: string | null; bytes: Uint8Array }>;
let putStatus: number;

function hostedWithStore() {
  vi.stubEnv('MCP_DATA_DIR', mkdtempSync(join(tmpdir(), 'rf-data-')));
  vi.stubEnv('MCP_BLOB_BASE_URL', BASE);
  vi.stubEnv('MCP_BLOB_SIGNING_KEY', 'a2V5');
}

/** The single entry of a zip buildZip wrote: its name and inflated contents. */
function unzipOne(zip: Uint8Array): { name: string; text: string } {
  const b = Buffer.from(zip);
  expect(b.readUInt32LE(0)).toBe(0x04034b50);
  const method = b.readUInt16LE(8);
  const size = b.readUInt32LE(18);
  const nameLen = b.readUInt16LE(26);
  const extraLen = b.readUInt16LE(28);
  const name = b.subarray(30, 30 + nameLen).toString('utf8');
  const data = b.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + size);
  return { name, text: (method === 8 ? inflateRawSync(data) : data).toString('utf8') };
}

beforeEach(() => {
  fetchStingrayJson.mockReset();
  outRoot = mkdtempSync(join(tmpdir(), 'rf-root-'));
  vi.stubEnv('REDFIN_OUTPUT_DIR', outRoot);
  vi.stubEnv('MCP_DATA_DIR', '');
  vi.stubEnv('MCP_BLOB_BASE_URL', '');
  vi.stubEnv('MCP_BLOB_SIGNING_KEY', '');
  puts = [];
  putStatus = 201;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    puts.push({ url, type: new Headers(init?.headers).get('content-type'), bytes: new Uint8Array(init!.body as ArrayBuffer) });
    return new Response(null, { status: putStatus });
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('redfin_sweep_area output on a hosted deployment', () => {
  it('uploads the full result set as a zip and returns a signed link, never touching disk', async () => {
    hostedWithStore();
    fetchStingrayJson.mockResolvedValueOnce({ payload: { homes: [home(1, 700000), home(2, 650000)] } });
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: 'area.json' });

    expect(s).not.toHaveProperty('output_path');
    expect(s).not.toHaveProperty('results');
    expect(s.output_file).toBe('area.json');
    expect(s.output_url).toMatch(new RegExp(`^${BASE}/exp/[A-Za-z0-9_-]+/part-0001\\.zip\\?exp=\\d+&sig=`));
    expect(Date.parse(s.output_expires_at!)).toBeGreaterThan(Date.now());
    expect(s.unique_listings).toBe(2);

    expect(puts).toHaveLength(1);
    expect(puts[0]!.type).toBe('application/zip');
    const entry = unzipOne(puts[0]!.bytes);
    expect(entry.name).toBe('area.json');
    const f = JSON.parse(entry.text);
    expect(f.results.map((r: { property_id: number }) => r.property_id)).toEqual([1, 2]);
    expect(f.query.output_path).toBeUndefined();

    expect(readdirSync(outRoot)).toEqual([]);
  });

  it('keeps only the file name of an absolute output_path (the runner disk is not the caller\'s)', async () => {
    hostedWithStore();
    fetchStingrayJson.mockResolvedValueOnce({ payload: { homes: [home(1, 700000)] } });
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: '/Users/someone/Downloads/sweep.json' });
    expect(s.output_file).toBe('sweep.json');
    expect(unzipOne(puts[0]!.bytes).name).toBe('sweep.json');
  });

  it('routes ZIP mode through the same link', async () => {
    hostedWithStore();
    fetchStingrayJson
      .mockResolvedValueOnce({ resultCode: 0, payload: { sections: [{ name: 'Places', rows: [{ id: '2_1', name: '90001', url: '/zipcode/90001' }] }] } })
      .mockResolvedValueOnce({ payload: { homes: [home(7, 500000)] } });
    const s = await sweepRedfinZips(client, { zips: ['90001'], delay_ms: 0, output_path: 'z.json' });
    expect(s.output_url).toMatch(/\/exp\/.+\/part-0001\.zip\?/);
    expect(s).not.toHaveProperty('results');
    expect(JSON.parse(unzipOne(puts[0]!.bytes).text).results.map((r: { property_id: number }) => r.property_id)).toEqual([7]);
  });

  it('still requires a .json name, before any request', async () => {
    hostedWithStore();
    await expect(sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: 'r.sh' })).rejects.toThrow(/\.json/);
    expect(fetchStingrayJson).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it('refuses output_path up front when hosted with no blob store, and says what to do', async () => {
    vi.stubEnv('MCP_DATA_DIR', mkdtempSync(join(tmpdir(), 'rf-data-')));
    await expect(sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: 'r.json' })).rejects.toThrow(
      /no blob store.*omit output_path/i
    );
    await expect(sweepRedfinZips(client, { zips: ['90001'], delay_ms: 0, output_path: 'r.json' })).rejects.toThrow(/no blob store/i);
    expect(fetchStingrayJson).not.toHaveBeenCalled();
    expect(readdirSync(outRoot)).toEqual([]);
  });

  it('returns the listings inline when hosted and no output_path is given', async () => {
    hostedWithStore();
    fetchStingrayJson.mockResolvedValueOnce({ payload: { homes: [home(1, 700000)] } });
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0 });
    expect(s.results?.map((r) => r.property_id)).toEqual([1]);
    expect(s).not.toHaveProperty('output_url');
    expect(puts).toHaveLength(0);
  });

  it('refuses a result set over the export cap with too_large and uploads nothing', async () => {
    hostedWithStore();
    fetchStingrayJson.mockResolvedValueOnce({ payload: { homes: [home(1, 700000), home(2, 650000)] } });
    const err = await sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: 'big.json' }, { exportMaxBytes: 64 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('too_large');
    expect(err.message).toMatch(/limit/);
    expect(puts).toHaveLength(0);
  });

  it('surfaces a failed upload instead of claiming a link', async () => {
    hostedWithStore();
    putStatus = 500;
    fetchStingrayJson.mockResolvedValueOnce({ payload: { homes: [home(1, 700000)] } });
    await expect(sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: 'r.json' })).rejects.toThrow();
  });
});

describe('redfin_sweep_area output locally', () => {
  it('writes to disk exactly as before and never calls the blob store', async () => {
    fetchStingrayJson.mockResolvedValueOnce({ payload: { homes: [home(1, 700000)] } });
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: 'r.json' });
    expect(s.output_path).toBe(join(outRoot, 'r.json'));
    expect(s).not.toHaveProperty('output_url');
    expect(readdirSync(outRoot)).toEqual(['r.json']);
    expect(puts).toHaveLength(0);
  });
});
