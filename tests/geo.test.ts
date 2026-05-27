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

  it('matched: true when any home is in a plausible state', () => {
    expect(homesMatchZipState('28746', ['NC', 'NC']).matched).toBe(true);
  });

  it('matched: true when one home matches even if others do not (NC + WA on shared border? unlikely but tolerant)', () => {
    expect(homesMatchZipState('28746', ['NC', 'WA']).matched).toBe(true);
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
