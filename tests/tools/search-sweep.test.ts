import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RedfinClient } from '../../src/client.js';
import {
  fetchPolyHomes,
  boundsToPoly,
  buildGisPolyPath,
  homeOutside,
  quarterBounds,
  areaLimited,
  sweepRedfinArea,
  assertRegionMatches,
  REDFIN_GIS_HARD_CAP,
  type RawHome,
} from '../../src/tools/search.js';

const fetchStingrayJson = vi.fn();
const client = { fetchStingrayJson } as unknown as RedfinClient;
beforeEach(() => fetchStingrayJson.mockReset());

const box = { north: 37.4, south: 37.2, east: -121.8, west: -122.0 };

function home(id: number, price: number, lat = 37.3, lng = -121.9, beds = 3, baths = 2, uipt = 3): RawHome {
  return { propertyId: id, price: { value: price }, beds, baths, uiPropertyType: uipt, city: 'San Jose', state: 'CA', zip: '95133', latLong: { value: { latitude: lat, longitude: lng } }, mlsStatus: 'Active' };
}

describe('polygon helpers', () => {
  it('builds a closed lng-lat ring', () => {
    expect(boundsToPoly(box)).toBe('-122.000000 37.200000,-121.800000 37.200000,-121.800000 37.400000,-122.000000 37.400000,-122.000000 37.200000');
  });
  it('builds a gis path with user_poly and no region', () => {
    const p = buildGisPolyPath(box, { location: '', price_max: 900000 });
    const qs = new URLSearchParams(p.split('?')[1]);
    expect(qs.get('user_poly')).toContain('-122.000000 37.200000');
    expect(p).toContain('user_poly=-122.000000+37.200000%2C');
    expect(qs.has('poly')).toBe(false);
    expect(qs.has('region_id')).toBe(false);
    expect(qs.get('num_homes')).toBe(String(REDFIN_GIS_HARD_CAP));
    expect(qs.get('max_price')).toBe('900000');
  });
  it('builds the other probe variants', () => {
    const al3 = new URLSearchParams(buildGisPolyPath(box, { location: '' }, 'user_poly_al3').split('?')[1]);
    expect(al3.get('al')).toBe('3');
    expect(al3.get('sp')).toBe('true');
    const reg = new URLSearchParams(buildGisPolyPath(box, { location: '' }, 'user_poly_region', { region_id: 17420, region_type: 6 }).split('?')[1]);
    expect(reg.get('region_id')).toBe('17420');
    expect(reg.has('user_poly')).toBe(true);
    const legacy = new URLSearchParams(buildGisPolyPath(box, { location: '' }, 'poly').split('?')[1]);
    expect(legacy.has('poly')).toBe(true);
  });
  it('areaLimited tolerates jitter but not a fallback region', () => {
    expect(areaLimited(0, 0)).toBe(true);
    expect(areaLimited(100, 2)).toBe(true);
    expect(areaLimited(350, 330)).toBe(false);
  });
  it('quarters and detects outside homes', () => {
    expect(quarterBounds(box)).toHaveLength(4);
    expect(homeOutside({ property_id: 1, url: '', portal_url_hyperlink: '', address: '', latitude: 37.5, longitude: -121.9 }, box)).toBe(true);
    expect(homeOutside({ property_id: 1, url: '', portal_url_hyperlink: '', address: '', latitude: 37.3, longitude: -121.9 }, box)).toBe(false);
  });
});

describe('sweepRedfinArea', () => {
  it('splits a capped tile, filters locally, dedupes and writes the full set', async () => {
    const capped = Array.from({ length: REDFIN_GIS_HARD_CAP }, (_, i) => home(i + 1, 700000));
    fetchStingrayJson.mockResolvedValueOnce({ payload: { homes: capped } });
    fetchStingrayJson
      .mockResolvedValueOnce({ payload: { homes: [home(5000, 800000, 37.35, -121.95), home(5001, 1500000, 37.35, -121.95)] } }) // 5001 fails price
      .mockResolvedValueOnce({ payload: { homes: [home(5000, 800000, 37.35, -121.95), home(5002, 650000, 37.35, -121.85)] } }) // dup 5000
      .mockResolvedValueOnce({ payload: { homes: [] } })
      .mockResolvedValueOnce({ payload: { homes: [home(5003, 600000, 37.25, -121.85, 1, 1)] } }); // fails beds
    const out = join(mkdtempSync(join(tmpdir(), 'rf-')), 'r.json');
    const s = await sweepRedfinArea(client, { bounds: box, price_max: 900000, beds_min: 2, delay_ms: 0, output_path: out });
    expect(s.complete).toBe(true);
    expect(s.split_tiles).toBe(1);
    expect(s.leaf_tiles).toBe(4);
    expect(s.unique_listings).toBe(2); // 5000, 5002
    expect(s.requests).toBe(5);
    const f = JSON.parse(readFileSync(out, 'utf8'));
    expect(f.results.map((r: { property_id: number }) => r.property_id).sort()).toEqual([5000, 5002]);
  });
  it('stops and reports incomplete when every polygon shape is ignored', async () => {
    fetchStingrayJson.mockResolvedValue({ payload: { homes: Array.from({ length: 10 }, (_, i) => home(i + 1, 1, 40.7, -74.0)) } });
    const out = join(mkdtempSync(join(tmpdir(), 'rf-')), 'r.json');
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: out });
    expect(s.complete).toBe(false);
    expect(s.poly_variant).toBeNull();
    expect(s.unique_listings).toBe(0);
    expect(s.requests).toBe(4); // user_poly, viewport, user_poly_al3, poly (no region known)
    expect(s.warnings.join(' ')).toMatch(/ignored every polygon request shape/);
  });
  it('falls through the probe, then locks the working shape for every tile', async () => {
    const elsewhere = Array.from({ length: 10 }, (_, i) => home(i + 1, 1, 40.7, -74.0));
    fetchStingrayJson
      .mockResolvedValueOnce({ payload: { homes: elsewhere } }) // user_poly ignored
      .mockResolvedValueOnce({ payload: { homes: [home(7, 700000)] } }); // viewport works
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0 });
    expect(s.poly_variant).toBe('viewport');
    expect(s.complete).toBe(true);
    expect(s.requests).toBe(2);
    expect(fetchStingrayJson.mock.calls[1][0]).toContain('viewport=37.4%3A37.2%3A-121.8%3A-122');
  });
  it('returns the listings inline when no output_path is given', async () => {
    fetchStingrayJson.mockResolvedValueOnce({ payload: { homes: [home(1, 700000), home(2, 650000)] } });
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0 });
    expect(s.complete).toBe(true);
    expect(s).not.toHaveProperty('output_path');
    expect(s.results?.map((r) => r.property_id)).toEqual([1, 2]);
  });
  it('reports incomplete when the budget runs out', async () => {
    fetchStingrayJson.mockResolvedValue({ payload: { homes: Array.from({ length: REDFIN_GIS_HARD_CAP }, (_, i) => home(i + 1, 1)) } });
    const out = join(mkdtempSync(join(tmpdir(), 'rf-')), 'r.json');
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0, max_requests: 3, output_path: out });
    expect(s.complete).toBe(false);
    expect(s.budget_hit).toBe(true);
  });
});

describe('sweepRedfinArea — follow-ups from #272', () => {
  it('drops homes outside the requested box even when the tile is area-limited', async () => {
    // 1 of 10 homes is well outside the root box: areaLimited tolerates it, the census must not.
    const homes = [...Array.from({ length: 9 }, (_, i) => home(i + 1, 700000)), home(99, 700000, 37.6, -121.9)];
    fetchStingrayJson.mockResolvedValueOnce({ payload: { homes } });
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0 });
    expect(s.results?.map((r) => r.property_id)).not.toContain(99);
    expect(s.unique_listings).toBe(9);
  });
  it('neither merges nor splits a tile that drifted after the probe passed', async () => {
    const capped = Array.from({ length: REDFIN_GIS_HARD_CAP }, (_, i) => home(i + 1, 700000));
    const drifted = Array.from({ length: REDFIN_GIS_HARD_CAP }, (_, i) => home(10_000 + i, 700000, 40.7, -74.0));
    fetchStingrayJson
      .mockResolvedValueOnce({ payload: { homes: capped } }) // root: probe passes, capped → split
      .mockResolvedValueOnce({ payload: { homes: drifted } }) // q0 drifts (and is "capped")
      .mockResolvedValueOnce({ payload: { homes: [home(5000, 700000, 37.35, -121.85)] } })
      .mockResolvedValueOnce({ payload: { homes: [] } })
      .mockResolvedValueOnce({ payload: { homes: [] } });
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0 });
    expect(s.requests).toBe(5); // the drifted tile is not quartered
    expect(s.drift_tiles).toBe(1);
    expect(s.complete).toBe(false);
    expect(s.results?.map((r) => r.property_id)).toEqual([5000]);
  });
  it('never sends more polygon probes than max_requests allows', async () => {
    fetchStingrayJson.mockResolvedValue({ payload: { homes: Array.from({ length: 10 }, (_, i) => home(i + 1, 1, 40.7, -74.0)) } });
    const s = await sweepRedfinArea(client, { bounds: box, delay_ms: 0, max_requests: 1 });
    expect(fetchStingrayJson).toHaveBeenCalledTimes(1);
    expect(s.requests).toBe(1);
    expect(s.budget_hit).toBe(true);
    expect(s.complete).toBe(false);
    // Budget ran out mid-probe: that is not evidence Redfin ignored the polygon.
    expect(s.warnings.join(' ')).not.toMatch(/ignored every polygon request shape/);
  });
  it('fetchPolyHomes stops probing at maxRequests', async () => {
    fetchStingrayJson.mockResolvedValue({ payload: { homes: Array.from({ length: 10 }, (_, i) => home(i + 1, 1, 40.7, -74.0)) } });
    const f = await fetchPolyHomes(client, box, { location: '' }, { maxRequests: 2 });
    expect(f.tried).toHaveLength(2);
    expect(f.variant).toBeNull();
    expect(f.truncated).toBe(true);
  });
  it('rejects a relative output_path before sending any request', async () => {
    await expect(sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: 'out/r.json' })).rejects.toThrow(/absolute/);
    await expect(sweepRedfinArea(client, { zips: ['95133'], delay_ms: 0, output_path: 'r.json' })).rejects.toThrow(/absolute/);
    expect(fetchStingrayJson).not.toHaveBeenCalled();
  });
  it('refuses to overwrite an existing output_path', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'rf-')), 'r.json');
    writeFileSync(out, 'keep me');
    await expect(sweepRedfinArea(client, { bounds: box, delay_ms: 0, output_path: out })).rejects.toThrow(/already exists/);
    expect(fetchStingrayJson).not.toHaveBeenCalled();
    expect(readFileSync(out, 'utf8')).toBe('keep me');
  });
});

describe('ZIP regions', () => {
  const ac = (zip: string, id: number) => ({
    resultCode: 0,
    payload: { sections: [{ name: 'Places', rows: [{ id: `2_${id}`, name: zip, url: `/zipcode/${zip}` }] }] },
  });
  const zh = (id: number, zip: string, price = 700000): RawHome => ({ ...home(id, price), zip });

  it('accepts a ZIP answer judged by the homes\' ZIPs despite a neighborhood serviceRegionName', () => {
    expect(() =>
      assertRegionMatches({ name: '95133', region_type: 2, region_id: 39438 }, { serviceRegionName: 'berryessa-alum-rock', homes: [{ city: 'San Jose', state: 'CA', zip: '95133' }, { city: 'San Jose', state: 'CA', zip: '95133' }] }, '95133')
    ).not.toThrow();
  });
  it('rejects a ZIP answer whose homes are mostly elsewhere', () => {
    expect(() =>
      assertRegionMatches({ name: '95133', region_type: 2, region_id: 39438 }, { homes: [{ city: 'San Jose', state: 'CA', zip: '95125' }, { city: 'San Jose', state: 'CA', zip: '95128' }] }, '95133')
    ).toThrow(/only 0 of 2/);
  });
  it('does not apply the homes-in-ZIP rule when the location resolved to a city', () => {
    // "San Jose, CA 95133" can resolve to the city; its homes span many ZIPs.
    expect(() =>
      assertRegionMatches(
        { name: 'San Jose', sub_name: 'San Jose, CA, USA', region_type: 6, region_id: 17420 },
        { serviceRegionName: 'san-jose', homes: [{ city: 'San Jose', state: 'CA', zip: '95125' }, { city: 'San Jose', state: 'CA', zip: '95128' }, { city: 'San Jose', state: 'CA', zip: '95133' }] },
        'San Jose, CA 95133'
      )
    ).not.toThrow();
  });
  it('stops a ZIP sweep at the request budget', async () => {
    fetchStingrayJson
      .mockResolvedValueOnce(ac('95133', 1)).mockResolvedValueOnce({ payload: { homes: [zh(1, '95133')] } })
      .mockResolvedValueOnce(ac('95131', 2)).mockResolvedValueOnce({ payload: { homes: [zh(2, '95131')] } });
    const s = await sweepRedfinArea(client, { zips: ['95133', '95131', '95035'], delay_ms: 0, max_requests: 4 });
    expect(fetchStingrayJson).toHaveBeenCalledTimes(4);
    expect(s.requests).toBe(4);
    expect(s.budget_hit).toBe(true);
    expect(s.complete).toBe(false);
    expect((s as { failed_zips: Array<{ zip: string; error: string }> }).failed_zips).toEqual([{ zip: '95035', error: 'request budget exhausted' }]);
    expect(s.results?.map((r) => r.property_id)).toEqual([1, 2]);
  });
  it('sweeps ZIPs, filters locally, flags capped and failed ZIPs', async () => {
    fetchStingrayJson
      .mockResolvedValueOnce(ac('95133', 1)).mockResolvedValueOnce({ payload: { serviceRegionName: 'berryessa', homes: [zh(1, '95133'), zh(2, '95133', 2_000_000)] } })
      .mockResolvedValueOnce(ac('95131', 2)).mockResolvedValueOnce({ payload: { homes: Array.from({ length: REDFIN_GIS_HARD_CAP }, (_, i) => zh(100 + i, '95131')) } })
      .mockResolvedValueOnce(ac('95035', 3)).mockResolvedValueOnce({ payload: { homes: [zh(9, '95128')] } }); // fallback
    const s = await sweepRedfinArea(client, { zips: ['95133', '95131', '95035'], price_max: 900000, delay_ms: 0 });
    expect(s.complete).toBe(false);
    expect(s).toMatchObject({ mode: 'zips', capped_zips: ['95131'] });
    expect((s as { failed_zips: Array<{ zip: string }> }).failed_zips.map((f) => f.zip)).toEqual(['95035']);
    expect(s.results?.some((r) => r.property_id === 1)).toBe(true);
    expect(s.results?.some((r) => r.property_id === 2)).toBe(false);
  });
});
