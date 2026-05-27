// Adapter-level tests for FetchproxyTransport. We don't bring up a real
// WebSocket here — the protocol-level tests live in @fetchproxy/server.
// What we verify is the path → URL prepending and the discriminated-
// union mapping (ok:true → triple, ok:false → throw).
import { describe, it, expect, vi } from 'vitest';
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';

type Inner = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
};

function stubInner(): Inner {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
  };
}

function installInner(t: FetchproxyTransport, inner: Inner): void {
  // @ts-expect-error reach into the private field for unit testing
  t.inner = inner;
}

describe('FetchproxyTransport', () => {
  it('prepends https://www.redfin.com to relative paths', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: 'x',
      url: 'https://www.redfin.com/x',
    });
    installInner(t, inner);

    await t.fetch({ path: '/home/40732555', method: 'GET' });
    expect(inner.fetch.mock.calls[0][0].url).toBe(
      'https://www.redfin.com/home/40732555'
    );
    expect(inner.fetch.mock.calls[0][0].tabUrl).toBe('https://www.redfin.com/');
  });

  it('passes through absolute URLs', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: '',
      url: 'https://photos.redfin.com/x',
    });
    installInner(t, inner);

    await t.fetch({
      path: 'https://photos.redfin.com/x',
      method: 'GET',
    });
    expect(inner.fetch.mock.calls[0][0].url).toBe('https://photos.redfin.com/x');
  });

  it('returns the {status, body, url} triple on ok:true', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
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

  it('throws when fetchproxy returns ok:false', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      error: 'extension offline',
    });
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /extension offline/
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

  it('LAZY REVIVE (#55): retries once on content_script_unreachable, succeeds on second attempt', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    let n = 0;
    inner.fetch.mockImplementation(async () => {
      n++;
      if (n === 1) {
        return {
          ok: false,
          kind: 'content_script_unreachable',
          error: 'service worker evicted',
        };
      }
      return {
        ok: true,
        status: 200,
        body: 'recovered',
        url: 'https://www.redfin.com/x',
      };
    });
    installInner(t, inner);

    const result = await t.fetch({ path: '/x', method: 'GET' });
    expect(result.body).toBe('recovered');
    expect(inner.fetch).toHaveBeenCalledTimes(2);
  }, 10_000); // wraps the 2s lazy-revive sleep

  it('LAZY REVIVE (#55): surfaces FetchproxyBridgeDownError when the retry also fails', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      kind: 'content_script_unreachable',
      error: 'service worker still evicted',
    });
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /fetchproxy bridge down/
    );
    // First call + one retry.
    expect(inner.fetch).toHaveBeenCalledTimes(2);
    // Hint mentions the auto-retry and the manual recovery options.
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /auto-retries once/
    );
  }, 30_000);

  it('records exactly one failure when bridge-down retry also fails (no double-count)', async () => {
    // One user-visible tool failure should bump consecutiveFailures by 1,
    // not 2 — even though fetchOnce ran twice (initial + lazy-revive retry).
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      kind: 'content_script_unreachable',
      error: 'service worker still evicted',
    });
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /fetchproxy bridge down/
    );
    expect(inner.fetch).toHaveBeenCalledTimes(2);
    expect(t.status().consecutiveFailures).toBe(1);
  }, 10_000);

  it('does NOT retry on non-bridge_down failures', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({ ok: false, error: 'something else' });
    installInner(t, inner);
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /something else/
    );
    expect(inner.fetch).toHaveBeenCalledTimes(1);
  });
});
