import { describe, it, expect, vi } from 'vitest';
import { urlToPath } from '../src/url.js';

describe('urlToPath', () => {
  it('strips the origin from an absolute Redfin URL', () => {
    expect(
      urlToPath('https://www.redfin.com/NY/Brooklyn/42-Monroe-St-11238/home/40732555')
    ).toBe('/NY/Brooklyn/42-Monroe-St-11238/home/40732555');
  });

  it('preserves the query string', () => {
    expect(urlToPath('https://www.redfin.com/x?a=1&b=2')).toBe('/x?a=1&b=2');
  });

  it('passes through a path that already starts with /', () => {
    expect(urlToPath('/already/path/')).toBe('/already/path/');
  });

  it('prepends / to a bare path segment', () => {
    expect(urlToPath('home/40732555')).toBe('/home/40732555');
  });

  it('handles URLs with hash fragments by dropping them', () => {
    // `hash` is intentionally left out — Redfin's server doesn't see it
    // anyway. Behavior choice: prefer path+search clean.
    expect(urlToPath('https://www.redfin.com/x#frag')).toBe('/x');
  });
});

describe('urlToPath — non-http(s) schemes (fleet-audit#675)', () => {
  it('throws on a host-confusable non-http scheme instead of returning a slash-less path', () => {
    // Before realty-core 0.5.1 this returned '@evil.com/home/1', which joins
    // as https://www.redfin.com@evil.com/home/1 — host evil.com.
    expect(() => urlToPath('x:@evil.com/home/1')).toThrow(/unsupported URL scheme/);
    expect(() => urlToPath('javascript:alert(1)//home/1')).toThrow(/unsupported URL scheme/);
    expect(() => urlToPath('file:///etc/passwd')).toThrow(/unsupported URL scheme/);
  });

  it('always returns a single-leading-slash path for http(s) and path input', () => {
    expect(urlToPath('//evil.com/home/1')).toBe('/evil.com/home/1');
    expect(urlToPath('http://www.redfin.com/home/1')).toBe('/home/1');
  });
});

describe('resolveIds rejects a non-http scheme URL cleanly, before any fetch (fleet-audit#675)', () => {
  it('errors with the scheme message and never dials Redfin', async () => {
    const { resolveIds } = await import('../src/tools/properties.js');
    const fetchStingrayJson = vi.fn();
    const client = { fetchStingrayJson } as never;
    await expect(resolveIds(client, { url: 'x:@evil.com/home/1' })).rejects.toThrow(
      /unsupported URL scheme/
    );
    expect(fetchStingrayJson).not.toHaveBeenCalled();
  });
});
