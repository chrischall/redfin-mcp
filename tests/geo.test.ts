import { describe, it, expect } from 'vitest';
import {
  extractZipFromLocation,
  homesMatchZipState,
  zipPlausibleStates,
} from '../src/geo.js';

describe('zipPlausibleStates', () => {
  it('CANONICAL REGRESSION: ZIP 28746 → must include NC, must NOT include WA', () => {
    const states = zipPlausibleStates('28746');
    expect(states).not.toBeNull();
    expect(states!.has('NC')).toBe(true);
    expect(states!.has('WA')).toBe(false);
  });

  it('tolerates ZIP+4', () => {
    expect(zipPlausibleStates('28746-1234')?.has('NC')).toBe(true);
  });

  it('returns null for non-5-digit input', () => {
    expect(zipPlausibleStates('M5V 3L9')).toBeNull(); // Canadian postal
    expect(zipPlausibleStates('1234')).toBeNull();
    expect(zipPlausibleStates(undefined)).toBeNull();
  });

  it('first-digit 9 includes Washington and Oregon', () => {
    const states = zipPlausibleStates('98103'); // Seattle Fremont
    expect(states!.has('WA')).toBe(true);
    expect(states!.has('OR')).toBe(true);
  });

  it('first-digit 0 includes New England states', () => {
    expect(zipPlausibleStates('02134')!.has('MA')).toBe(true);
  });
});

describe('homesMatchZipState', () => {
  it('CANONICAL REGRESSION: ZIP 28746 with Seattle (WA) homes → matched: false', () => {
    const result = homesMatchZipState('28746', ['WA', 'WA', 'WA']);
    expect(result.plausibleStates?.has('NC')).toBe(true);
    expect(result.matched).toBe(false);
  });

  it('matched: true when all homes are in a plausible state', () => {
    expect(homesMatchZipState('28746', ['NC', 'NC']).matched).toBe(true);
  });

  it('matched: true when a strict majority of homes are state-plausible', () => {
    // 2 of 3 in NC clears the >50% threshold — one stray WA home does
    // not flip a clearly-NC result to "not matched".
    expect(homesMatchZipState('28746', ['NC', 'NC', 'WA']).matched).toBe(true);
  });

  it('CANONICAL REGRESSION (#46 poisoned set): a single in-state home does NOT rescue a cross-continent set', () => {
    // The under-firing bug: ZIP 28746 (NC) returning a Seattle-heavy
    // set with one NC home would pass the old any-one-match guard.
    // With the majority threshold, 1-of-4 NC is below 50% → matched: false.
    expect(
      homesMatchZipState('28746', ['WA', 'WA', 'WA', 'NC']).matched
    ).toBe(false);
  });

  it('matched: false on an even NC/WA split — 50% is not a majority', () => {
    // A tie (1 NC, 1 WA) fails the strict-majority test, so a mixed/
    // poisoned half-and-half set is treated as not-matched.
    expect(homesMatchZipState('28746', ['NC', 'WA']).matched).toBe(false);
  });

  it('matched: null when no homes provided', () => {
    expect(homesMatchZipState('28746', []).matched).toBeNull();
  });

  it('matched: null when ZIP cannot be parsed', () => {
    expect(homesMatchZipState('not-a-zip', ['NC']).matched).toBeNull();
  });
});

describe('extractZipFromLocation', () => {
  it('finds a bare 5-digit ZIP', () => {
    expect(extractZipFromLocation('28746')).toBe('28746');
  });
  it('finds an embedded ZIP', () => {
    expect(extractZipFromLocation('Lake Lure NC 28746')).toBe('28746');
  });
  it('finds the leading 5 of a ZIP+4', () => {
    expect(extractZipFromLocation('28746-1234')).toBe('28746');
  });
  it('returns null for non-ZIP input', () => {
    expect(extractZipFromLocation('Brooklyn, NY')).toBeNull();
  });
  it('returns null for undefined', () => {
    expect(extractZipFromLocation(undefined)).toBeNull();
  });
});
