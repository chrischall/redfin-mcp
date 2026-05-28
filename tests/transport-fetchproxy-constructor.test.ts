// Constructor-options tests for FetchproxyTransport. Split out from
// transport-fetchproxy.test.ts because asserting on the options object
// passed to `new FetchproxyServer(...)` requires a hoisted vi.mock of
// '@fetchproxy/server', which would otherwise interfere with the
// installInner() stubbing pattern used by the main suite.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchproxyServerOpts } from '@fetchproxy/server';

const constructorCalls: FetchproxyServerOpts[] = [];

vi.mock('@fetchproxy/server', async () => {
  const actual =
    await vi.importActual<typeof import('@fetchproxy/server')>(
      '@fetchproxy/server'
    );
  class MockFetchproxyServer {
    public role: string | null = 'mock';
    constructor(opts: FetchproxyServerOpts) {
      constructorCalls.push(opts);
    }
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- test stub
    async listen(): Promise<void> {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- test stub
    async close(): Promise<void> {}
  }
  return { ...actual, FetchproxyServer: MockFetchproxyServer };
});

beforeEach(() => {
  constructorCalls.length = 0;
});

describe('FetchproxyTransport — constructor options', () => {
  it('passes keepAliveIntervalMs: 25_000 to the FetchproxyServer constructor (fetchproxy#71, closes #80)', async () => {
    const { FetchproxyTransport } = await import(
      '../src/transport-fetchproxy.js'
    );
    new FetchproxyTransport({ version: '0.0.0-test' });
    expect(constructorCalls.length).toBe(1);
    expect(constructorCalls[0]!.keepAliveIntervalMs).toBe(25_000);
  });
});
