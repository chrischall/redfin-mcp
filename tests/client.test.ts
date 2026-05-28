// RedfinClient unit tests — error mapping, sign-in detection, and the
// stingray-specific helper (`{}&&` prefix stripping + envelope check).
import { describe, it, expect, vi } from 'vitest';
import {
  RedfinClient,
  SessionNotAuthenticatedError,
  stripStingrayPrefix,
} from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  RedfinTransport,
} from '../src/transport.js';

function stubTransport(
  handler: (init: FetchInit) => Promise<FetchResult>
): RedfinTransport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockImplementation(handler),
    // 0.10.0+: `fetchJson` now delegates to `transport.requestJson`,
    // which (in the real FetchproxyTransport) hands off to the server's
    // `requestJson`. Mirror that serialize-body / JSON-header-default /
    // 204-as-null / JSON.parse contract here over the same `handler` so
    // the existing fetch-shaped stubs keep working.
    requestJson: vi
      .fn()
      .mockImplementation(
        async (
          method: 'GET' | 'POST' | 'PUT' | 'DELETE',
          path: string,
          opts: { headers?: Record<string, string>; body?: unknown } = {}
        ) => {
          const init: FetchInit = {
            path,
            method,
            headers: {
              Accept: 'application/json',
              ...(method !== 'GET' && opts.body !== undefined
                ? { 'Content-Type': 'application/json' }
                : {}),
              ...(opts.headers ?? {}),
            },
            body:
              method === 'GET' || opts.body === undefined
                ? undefined
                : JSON.stringify(opts.body),
          };
          const result = await handler(init);
          const data =
            result.status === 204 || result.body === ''
              ? null
              : JSON.parse(result.body);
          return { data, result };
        }
      ),
    runProbe: vi.fn(),
    status: vi.fn(),
  } as unknown as RedfinTransport;
}

describe('stripStingrayPrefix', () => {
  it('strips a leading {}&& prefix', () => {
    expect(stripStingrayPrefix('{}&&{"a":1}')).toBe('{"a":1}');
  });
  it('leaves the body untouched when no prefix', () => {
    expect(stripStingrayPrefix('{"a":1}')).toBe('{"a":1}');
  });
});

describe('RedfinClient', () => {
  it('fetchHtml returns the body when transport replies 200', async () => {
    const client = new RedfinClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html>page</html>',
        url: 'https://www.redfin.com/x',
      })),
    });
    expect(await client.fetchHtml('/x')).toBe('<html>page</html>');
  });

  it('fetchHtml throws SessionNotAuthenticatedError on /login redirect', async () => {
    const client = new RedfinClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html>login form</html>',
        url: 'https://www.redfin.com/login',
      })),
    });
    await expect(client.fetchHtml('/myredfin/favorites')).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError
    );
  });

  it('fetchHtml throws SessionNotAuthenticatedError on AWS WAF challenge', async () => {
    const client = new RedfinClient({
      transport: stubTransport(async () => ({
        status: 200,
        body:
          '<html><head><script src="https://22af.edge.sdk.awswaf.com/x/y/challenge.js"></script></head></html>',
        url: 'https://www.redfin.com/x',
      })),
    });
    await expect(client.fetchHtml('/x')).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError
    );
  });

  it('fetchHtml does NOT false-positive on a normal page mentioning awswaf.com in a large body', async () => {
    const big = 'x'.repeat(100_000) + 'awswaf.com challenge.js';
    const client = new RedfinClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: big,
        url: 'https://www.redfin.com/privacy',
      })),
    });
    await expect(client.fetchHtml('/privacy')).resolves.toBeDefined();
  });

  it('fetchHtml throws for non-2xx status', async () => {
    const client = new RedfinClient({
      transport: stubTransport(async () => ({
        status: 500,
        body: 'oops',
        url: 'https://www.redfin.com/x',
      })),
    });
    await expect(client.fetchHtml('/x')).rejects.toThrow(/500/);
  });

  it('fetchStingrayJson strips {}&& and parses the envelope', async () => {
    const client = new RedfinClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '{}&&{"version":642,"errorMessage":"Success","resultCode":0,"payload":{"hello":"world"}}',
        url: 'https://www.redfin.com/stingray/api/x',
      })),
    });
    const env = await client.fetchStingrayJson<{ hello: string }>(
      '/stingray/api/x'
    );
    expect(env.resultCode).toBe(0);
    expect(env.payload?.hello).toBe('world');
  });

  it('fetchStingrayJson throws when resultCode != 0', async () => {
    const client = new RedfinClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '{}&&{"resultCode":17,"errorMessage":"bad request","payload":null}',
        url: 'https://www.redfin.com/stingray/api/x',
      })),
    });
    await expect(client.fetchStingrayJson('/stingray/api/x')).rejects.toThrow(
      /resultCode=17/
    );
  });

  it('fetchStingrayJson throws on invalid JSON after stripping prefix', async () => {
    const client = new RedfinClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '{}&&not-json',
        url: 'https://www.redfin.com/stingray/api/x',
      })),
    });
    await expect(client.fetchStingrayJson('/stingray/api/x')).rejects.toThrow(
      /was not JSON/
    );
  });

  it('fetchJson POSTs JSON and parses the reply', async () => {
    const client = new RedfinClient({
      transport: stubTransport(async (init) => {
        expect(init.method).toBe('POST');
        const body = JSON.parse(String(init.body));
        return {
          status: 200,
          body: JSON.stringify({ echoed: body }),
          url: 'https://www.redfin.com/x',
        };
      }),
    });
    const r = await client.fetchJson<{ echoed: { n: number } }>('/x', {
      method: 'POST',
      body: { n: 42 },
    });
    expect(r.echoed.n).toBe(42);
  });

  it('fetchJson returns null for 204', async () => {
    const client = new RedfinClient({
      transport: stubTransport(async () => ({
        status: 204,
        body: '',
        url: 'https://www.redfin.com/x',
      })),
    });
    expect(await client.fetchJson('/x', { method: 'POST', body: {} })).toBeNull();
  });
});
