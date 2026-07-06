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
    const err = await client.fetchHtml('/myredfin/favorites').then(
      () => {
        throw new Error('expected fetchHtml to reject');
      },
      (e: unknown) => e
    );
    // Shared mcp-utils error, parameterized with the service + sign-in host.
    expect(err).toBeInstanceOf(SessionNotAuthenticatedError);
    expect((err as Error).message).toContain('Not signed in to Redfin.');
    expect((err as Error).message).toContain(
      'Open redfin.com in your browser and sign in, then try again.'
    );
    // The shared class carries a machine-readable `hint` the tool
    // surface can present separately (the old local class had none).
    expect((err as SessionNotAuthenticatedError).hint).toBe(
      'Open redfin.com in your browser and sign in, then try again.'
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

  describe('resolveCanonicalUrl', () => {
    it('GETs /home/<id> and returns the redirected canonical slug URL', async () => {
      const client = new RedfinClient({
        transport: stubTransport(async (init) => {
          expect(init.method).toBe('GET');
          expect(init.path).toBe('/home/12345');
          return {
            status: 200,
            body: '<html>home page</html>',
            // Browser fetch followed Redfin's /home/<id> -> canonical redirect.
            url: 'https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345',
          };
        }),
      });
      expect(await client.resolveCanonicalUrl(12345)).toBe(
        'https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345'
      );
    });

    it('throws SessionNotAuthenticatedError when /home/<id> redirects to /login', async () => {
      const client = new RedfinClient({
        transport: stubTransport(async () => ({
          status: 200,
          body: '<html>login</html>',
          url: 'https://www.redfin.com/login',
        })),
      });
      await expect(client.resolveCanonicalUrl(12345)).rejects.toBeInstanceOf(
        SessionNotAuthenticatedError
      );
    });

    it('throws a hint-laden error when no redirect occurred (still the bare /home/<id> form)', async () => {
      const client = new RedfinClient({
        transport: stubTransport(async () => ({
          status: 200,
          body: '<html>not found</html>',
          // No slug — redirect did not resolve (invalid/delisted id).
          url: 'https://www.redfin.com/home/12345',
        })),
      });
      await expect(client.resolveCanonicalUrl(12345)).rejects.toThrow(
        /could not be resolved/
      );
    });

    it('throws for a non-2xx status', async () => {
      const client = new RedfinClient({
        transport: stubTransport(async () => ({
          status: 404,
          body: 'nope',
          url: 'https://www.redfin.com/home/12345',
        })),
      });
      await expect(client.resolveCanonicalUrl(12345)).rejects.toThrow(/404/);
    });
  });
});
