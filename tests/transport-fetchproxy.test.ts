// Adapter-level tests for FetchproxyTransport. As of @fetchproxy/server
// 0.8.0, lazy-revive, per-request timeouts, and freshness counters are
// owned by the server itself (covered by its own test suite). The verb
// surface (fetch / runProbe / status) is now the shared
// `createFetchproxyTransport` verb adapter from
// @chrischall/mcp-utils/fetchproxy. What's left to test here is the thin
// redfin-specific class: it delegates each verb to the inner verb
// transport, applies subdomain 'www' via the adapter, and projects the
// {status, body, url} triple / BridgeStatus snapshot.
import { describe, it, expect, vi } from 'vitest';
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';

type Inner = {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  runProbe: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  role: 'host' | 'peer' | null;
};

function stubInner(): Inner {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    runProbe: vi.fn(),
    status: vi.fn().mockReturnValue({
      role: null,
      port: 37149,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    }),
    role: null,
  };
}

function installInner(t: FetchproxyTransport, inner: Inner): void {
  // @ts-expect-error reach into the private field for unit testing
  t.inner = inner;
}

describe('FetchproxyTransport', () => {
  it('passes path + method + subdomain:www to the inner verb adapter', async () => {
    // The adapter applies `defaultSubdomain: 'www'`, so this class no longer
    // threads `subdomain` itself — it forwards method/path/headers/body and
    // the adapter fills the default.
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      status: 200,
      body: 'x',
      url: 'https://www.redfin.com/home/40732555',
    });
    installInner(t, inner);

    await t.fetch({ path: '/home/40732555', method: 'GET' });
    expect(inner.fetch).toHaveBeenCalledWith({
      method: 'GET',
      path: '/home/40732555',
      headers: undefined,
      body: undefined,
    });
  });

  it('forwards absolute URLs to the inner verb adapter unchanged', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      status: 200,
      body: '',
      url: 'https://photos.redfin.com/x',
    });
    installInner(t, inner);

    await t.fetch({ path: 'https://photos.redfin.com/x', method: 'GET' });
    expect(inner.fetch.mock.calls[0][0].path).toBe('https://photos.redfin.com/x');
  });

  it('returns the {status, body, url} triple from a successful request', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      status: 200,
      body: 'hello',
      url: 'https://www.redfin.com/x',
    });
    installInner(t, inner);

    const result = await t.fetch({ path: '/x', method: 'GET' });
    expect(result).toEqual({
      status: 200,
      body: 'hello',
      url: 'https://www.redfin.com/x',
    });
  });

  it('lets typed errors from the inner verb adapter propagate to the caller', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockRejectedValue(new Error('bridge boom'));
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /bridge boom/
    );
  });

  it('start/close delegate to the inner verb transport', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    installInner(t, inner);

    await t.start();
    expect(inner.start).toHaveBeenCalledTimes(1);

    await t.close();
    expect(inner.close).toHaveBeenCalledTimes(1);
  });

  it('runProbe delegates to the inner verb transport', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    const probeResult = { ok: true } as unknown;
    inner.runProbe.mockResolvedValue(probeResult);
    installInner(t, inner);

    const fetchFn = vi.fn();
    const out = await t.runProbe(fetchFn, '/robots.txt');
    expect(inner.runProbe).toHaveBeenCalledWith(fetchFn, '/robots.txt');
    expect(out).toBe(probeResult);
  });

  it('status() delegates directly to the inner verb transport status()', () => {
    const t = new FetchproxyTransport({ version: '1.2.3' });
    const inner = stubInner();
    inner.status.mockReturnValue({
      role: 'host',
      port: 37149,
      serverVersion: '1.2.3',
      fetchTimeoutMs: 30_000,
      bridgeReviveDelayMs: 2_000,
      lastSuccessAt: 1000,
      lastFailureAt: 500,
      lastFailureReason: 'oops',
      consecutiveFailures: 0,
      lastExtensionMessageAt: 1100,
    });
    installInner(t, inner);

    const s = t.status();
    expect(s.role).toBe('host');
    expect(s.port).toBe(37149);
    expect(s.serverVersion).toBe('1.2.3');
    expect(s.fetchTimeoutMs).toBe(30_000);
    expect(s.bridgeReviveDelayMs).toBe(2_000);
    expect(s.lastSuccessAt).toBe(1000);
    expect(s.lastFailureAt).toBe(500);
    expect(s.lastFailureReason).toBe('oops');
    expect(s.consecutiveFailures).toBe(0);
  });
});
