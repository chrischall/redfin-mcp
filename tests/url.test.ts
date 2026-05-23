import { describe, it, expect } from 'vitest';
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
