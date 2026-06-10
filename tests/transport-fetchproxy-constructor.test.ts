// Constructor-options tests for FetchproxyTransport. Split out from
// transport-fetchproxy.test.ts because asserting on the options object
// passed into the verb-adapter factory requires a hoisted vi.mock of
// '@chrischall/mcp-utils/fetchproxy' (the subpath the adapter now imports
// `createFetchproxyTransport` from), which would otherwise interfere with
// the installInner() stubbing pattern used by the main suite.
//
// The class delegates its FetchproxyServer construction to
// `createFetchproxyTransport` (the 0.8+ verb adapter), so the opts that
// used to be asserted on `new FetchproxyServer(...)` are now asserted on
// the factory call — the factory forwards the full FetchproxyServerOpts
// verbatim, so the same knobs (defaultSubdomain, fetchTimeoutMs,
// keepAliveIntervalMs) ride through.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreateFetchproxyTransportOptions } from '@chrischall/mcp-utils/fetchproxy';

const factoryCalls: CreateFetchproxyTransportOptions[] = [];

vi.mock('@chrischall/mcp-utils/fetchproxy', async () => {
  const actual =
    await vi.importActual<typeof import('@chrischall/mcp-utils/fetchproxy')>(
      '@chrischall/mcp-utils/fetchproxy'
    );
  return {
    ...actual,
    createFetchproxyTransport: (opts: CreateFetchproxyTransportOptions) => {
      factoryCalls.push(opts);
      // A minimal stand-in — these tests only assert on the opts.
      return { role: 'mock' };
    },
  };
});

beforeEach(() => {
  factoryCalls.length = 0;
});

describe('FetchproxyTransport — constructor options', () => {
  it('passes defaultSubdomain:www to the verb adapter (matches the old per-call subdomain)', async () => {
    const { FetchproxyTransport } = await import(
      '../src/transport-fetchproxy.js'
    );
    new FetchproxyTransport({ version: '0.0.0-test' });
    expect(factoryCalls.length).toBe(1);
    expect(factoryCalls[0]!.defaultSubdomain).toBe('www');
    expect(factoryCalls[0]!.serverName).toBe('redfin-mcp');
    expect(factoryCalls[0]!.domains).toEqual(['redfin.com']);
  });

  it('does NOT pass keepAliveIntervalMs — relies on the server-side 25s default (fetchproxy#72)', async () => {
    const { FetchproxyTransport } = await import(
      '../src/transport-fetchproxy.js'
    );
    new FetchproxyTransport({ version: '0.0.0-test' });
    expect(factoryCalls.length).toBe(1);
    // The whole consumer cohort had been opting into exactly the 25_000ms
    // value, so we stopped forwarding it. Behavior is identical (SW kept
    // resident).
    expect(factoryCalls[0]!.keepAliveIntervalMs).toBeUndefined();
  });

  it('omits fetchTimeoutMs when not explicitly provided (relies on server-side 30s default)', async () => {
    const { FetchproxyTransport } = await import(
      '../src/transport-fetchproxy.js'
    );
    new FetchproxyTransport({ version: '0.0.0-test' });
    expect(factoryCalls.length).toBe(1);
    expect(factoryCalls[0]!.fetchTimeoutMs).toBeUndefined();
  });

  it('forwards fetchTimeoutMs to the verb adapter when explicitly provided', async () => {
    const { FetchproxyTransport } = await import(
      '../src/transport-fetchproxy.js'
    );
    new FetchproxyTransport({ version: '0.0.0-test', fetchTimeoutMs: 20_000 });
    expect(factoryCalls.length).toBe(1);
    expect(factoryCalls[0]!.fetchTimeoutMs).toBe(20_000);
  });
});
