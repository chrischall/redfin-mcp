// Adapter-level tests for FetchproxyTransport. As of @fetchproxy/server
// 0.8.0, lazy-revive, per-request timeouts, and freshness counters are
// owned by the server itself (covered by its own test suite). What's
// left here is the thin adapter: URL building via inner.request() and
// the BridgeStatus snapshot pulled from inner.bridgeHealth().
import { describe, it, expect, vi } from 'vitest';
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';

type Inner = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  bridgeHealth: ReturnType<typeof vi.fn>;
  role: 'host' | 'peer' | null;
};

function stubInner(): Inner {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    bridgeHealth: vi.fn().mockReturnValue({
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
  it('passes path + method + subdomain:www to inner.request', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: 'x',
      url: 'https://www.redfin.com/home/40732555',
    });
    installInner(t, inner);

    await t.fetch({ path: '/home/40732555', method: 'GET' });
    expect(inner.request).toHaveBeenCalledWith('GET', '/home/40732555', {
      subdomain: 'www',
      headers: undefined,
      body: undefined,
    });
  });

  it('passes through absolute URLs to inner.request unchanged', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: '',
      url: 'https://photos.redfin.com/x',
    });
    installInner(t, inner);

    await t.fetch({ path: 'https://photos.redfin.com/x', method: 'GET' });
    expect(inner.request.mock.calls[0][1]).toBe('https://photos.redfin.com/x');
  });

  it('returns the {status, body, url} triple from a successful request', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
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

  it('lets typed errors from inner.request propagate to the caller', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockRejectedValue(new Error('bridge boom'));
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /bridge boom/
    );
  });

  it('start/close delegate to the inner FetchproxyServer', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    installInner(t, inner);

    await t.start();
    expect(inner.listen).toHaveBeenCalledTimes(1);

    await t.close();
    expect(inner.close).toHaveBeenCalledTimes(1);
  });

  it('status() delegates directly to inner.bridgeHealth() (0.8.0+ collapsed the shim)', () => {
    const t = new FetchproxyTransport({ version: '1.2.3' });
    const inner = stubInner();
    inner.bridgeHealth.mockReturnValue({
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
