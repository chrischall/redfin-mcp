import { describe, it, expect } from 'vitest';
import { resolveWsPort } from '../src/port.js';

// fleet-audit #674: `Number('37149x')` is NaN, and NaN used to be handed to
// the fetchproxy transport, failing at bind time with an unrelated error.
describe('resolveWsPort', () => {
  it('returns undefined when REDFIN_WS_PORT is unset (transport default)', () => {
    expect(resolveWsPort(undefined)).toBeUndefined();
  });

  it.each([
    ['37149', 37149],
    ['1', 1],
    ['65535', 65535],
  ])('accepts %s', (raw, port) => {
    expect(resolveWsPort(raw)).toBe(port);
  });

  it.each(['37149x', 'abc', '0', '65536', '1.5', '-1', '0x10', ''])(
    'fails fast with a clear message on %j',
    (raw) => {
      expect(() => resolveWsPort(raw)).toThrow(
        /REDFIN_WS_PORT must be an integer from 1 to 65535/
      );
    }
  );
});
