// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// redfin-mcp's RedfinTransport interface.
//
// What this layer DOES instrument (boundary visibility):
//   - The `role` (host vs peer) the FetchproxyServer landed in after
//     `listen()`. Logged once to stderr on startup.
//   - Per-request timing around `this.inner.fetch(...)` when
//     REDFIN_DEBUG=1 is set in the env.
//   - The timeout error carries the role, port, elapsed ms, and the
//     failed URL so the user can tell "bridge never came up" apart
//     from "single request stalled in flight."
//
// What this layer CAN'T instrument (lives upstream in
// https://github.com/chrischall/fetchproxy):
//   - Service worker wake-up + message-listener binding
//   - Content-script injection on the active tab
//   - Tab selection (which redfin.com tab the SW picked)
//   - The window.fetch() that actually runs in the page
// If you need that level of detail, file an issue / PR upstream — the
// hooks would need to land in the @fetchproxy/server protocol.

import {
  FetchproxyServer,
  type FetchproxyServerOpts,
} from '@fetchproxy/server';
import type {
  BridgeStatus,
  FetchInit,
  FetchResult,
  RedfinTransport,
} from './transport.js';

const REDFIN_ORIGIN = 'https://www.redfin.com';
const REDFIN_TAB_URL = 'https://www.redfin.com/';

// Generous deadline for a Redfin response; the bridge has no native
// timeout, so a frozen tab / dropped extension would otherwise hang
// the MCP call indefinitely.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_PORT = 37_149;

const DEBUG = process.env.REDFIN_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[redfin-mcp:bridge]', ...args);
}

/**
 * Thrown when the upstream extension's service worker is unreachable.
 * Distinct from `FetchproxyTimeoutError` (no response within timeout)
 * and from a generic transport `Error` (any other ok:false reason).
 * Carries the same role/port/elapsed diagnostic surface so callers
 * can show users one consistent failure shape.
 */
export class FetchproxyBridgeDownError extends Error {
  readonly url: string;
  readonly elapsedMs: number;
  readonly role: 'host' | 'peer' | null;
  readonly port: number;
  readonly originalError: string;
  readonly hint: string;

  constructor(args: {
    url: string;
    elapsedMs: number;
    role: 'host' | 'peer' | null;
    port: number;
    originalError: string;
  }) {
    const hint =
      `the fetchproxy browser extension's service worker is not ` +
      `responding ("${args.originalError}"). Chrome evicts extension ` +
      `service workers after ~30s idle by default — redfin-mcp now auto-` +
      `retries once after a brief delay (issue #55), but this error means ` +
      `the second attempt also failed. To wake the extension: (a) click the ` +
      `fetchproxy toolbar icon, (b) open any redfin.com tab and reload, or ` +
      `(c) open chrome://extensions and toggle fetchproxy off + on. ` +
      `If the extension is missing entirely, install it from ` +
      `https://github.com/chrischall/fetchproxy.`;
    super(
      `fetchproxy bridge down: ${args.url} after ${args.elapsedMs}ms ` +
        `(role=${args.role ?? 'null'} port=${args.port}). ${hint}`
    );
    this.name = 'FetchproxyBridgeDownError';
    this.url = args.url;
    this.elapsedMs = args.elapsedMs;
    this.role = args.role;
    this.port = args.port;
    this.originalError = args.originalError;
    this.hint = hint;
  }
}

/**
 * Thrown when a request didn't get a response within `fetchTimeoutMs`.
 * Carries enough diagnostic context to distinguish:
 *   - bridge never came up (`role` = null, time elapsed ≈ timeout)
 *   - bridge came up but no extension connected yet
 *   - bridge + extension connected, single request stalled
 */
export class FetchproxyTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly role: 'host' | 'peer' | null;
  readonly port: number;
  readonly hint: string;

  constructor(args: {
    url: string;
    timeoutMs: number;
    elapsedMs: number;
    role: 'host' | 'peer' | null;
    port: number;
  }) {
    const hint =
      args.role === null
        ? `the bridge never bound role on startup — listen() may have failed before this request fired. Check stderr from redfin-mcp's startup banner.`
        : `bridge is role=${args.role} on port ${args.port}, so the WebSocket side is up; the request reached the bridge but no upstream response arrived within ${args.timeoutMs}ms. Most common causes: (a) the fetchproxy browser extension isn't connected to this MCP yet (check the extension popup for a green dot next to "redfin-mcp"), (b) the signed-in redfin.com tab is sleeping or was navigated away from before the request resolved, (c) the upstream redfin.com fetch itself is hanging on a login redirect or behavioral challenge.`;
    super(
      `fetchproxy: ${args.url} did not respond within ${args.timeoutMs}ms ` +
        `(elapsed ${args.elapsedMs}ms; bridge role=${args.role ?? 'null'} port=${args.port}). ` +
        hint
    );
    this.name = 'FetchproxyTimeoutError';
    this.url = args.url;
    this.timeoutMs = args.timeoutMs;
    this.elapsedMs = args.elapsedMs;
    this.role = args.role;
    this.port = args.port;
    this.hint = hint;
  }
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'redfin-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
  /** Per-request timeout in ms. Default 30s. */
  fetchTimeoutMs?: number;
}

export class FetchproxyTransport implements RedfinTransport {
  private readonly inner: FetchproxyServer;
  private readonly fetchTimeoutMs: number;
  private readonly port: number;
  private readonly serverVersion: string;
  // Freshness counters surfaced through `status()` so `redfin_healthcheck`
  // can answer "is this bridge healthy or limping along?". Reset by a
  // success, not by close()/start() — we want a process-wide history.
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureReason: string | null = null;
  private consecutiveFailures = 0;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'redfin-mcp',
      version: opts.version,
      // Subdomains of redfin.com (www, photos, etc.) match automatically.
      domains: ['redfin.com'],
    };
    this.inner = new FetchproxyServer(options);
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    log('listen start', { port: this.port, version: this.serverVersion });
    await this.inner.listen();
    // Stderr-only — stdio MCP transports reserve stdout for JSON-RPC.
    console.error(
      `[redfin-mcp:bridge] listening on 127.0.0.1:${this.port} ` +
        `(role=${this.inner.role ?? 'unknown'}, version=${this.serverVersion})`
    );
  }

  async close(): Promise<void> {
    log('close');
    return this.inner.close();
  }

  /**
   * Diagnostic snapshot of the bridge. Safe to call before `start()` —
   * `role` will be null until `listen()` resolves; freshness counters
   * are null/0 until the first request fires.
   */
  status(): BridgeStatus {
    return {
      role: this.inner.role,
      port: this.port,
      serverVersion: this.serverVersion,
      fetchTimeoutMs: this.fetchTimeoutMs,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private recordSuccess(): void {
    this.lastSuccessAt = Date.now();
    this.consecutiveFailures = 0;
  }

  private recordFailure(reason: string): void {
    this.lastFailureAt = Date.now();
    this.lastFailureReason = reason;
    this.consecutiveFailures += 1;
  }

  /**
   * Retry-once wrapper around {@link fetchOnce}. Issue #55: Chrome
   * evicts the fetchproxy extension's service worker after ~30s idle,
   * so the FIRST request after an idle period often returns a
   * `content_script_unreachable` error even though the extension comes
   * back online almost immediately on the next attempt. Lazy revive:
   * on `FetchproxyBridgeDownError`, sleep briefly and try once more.
   * Surfaces the second failure to the caller if it persists.
   *
   * Bridge-down `recordFailure` accounting lives here (not in
   * `fetchOnce`) so that one user-visible tool error increments
   * `consecutiveFailures` by exactly 1, even when the retry also
   * fails. Other failure modes (timeout, non-bridge-down ok:false)
   * still record once inside `fetchOnce` because they don't trigger
   * the retry path.
   */
  async fetch(init: FetchInit): Promise<FetchResult> {
    try {
      return await this.fetchOnce(init);
    } catch (err) {
      if (err instanceof FetchproxyBridgeDownError) {
        log('fetch:bridge-down-retry', { url: err.url });
        // Give Chrome ~2s to wake the service worker on the next fetch
        // arrival. Empirically shorter delays sometimes still see the
        // SW as evicted.
        await new Promise((r) => setTimeout(r, 2000));
        try {
          return await this.fetchOnce(init);
        } catch (retryErr) {
          if (retryErr instanceof FetchproxyBridgeDownError) {
            this.recordFailure(retryErr.originalError);
          }
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async fetchOnce(init: FetchInit): Promise<FetchResult> {
    const url = init.path.startsWith('http')
      ? init.path
      : `${REDFIN_ORIGIN}${init.path}`;
    const start = Date.now();
    log('fetch:start', {
      method: init.method,
      url,
      role: this.inner.role,
      port: this.port,
    });
    const inner = this.inner.fetch({
      url,
      method: init.method,
      tabUrl: REDFIN_TAB_URL,
      headers: init.headers,
      body: init.body,
    });
    // Attach a no-op rejection handler up front so a WS drop or other
    // late failure on `inner` — arriving AFTER the race already settled
    // on the timeout side — doesn't become an unhandled rejection that
    // crashes the MCP server in Node ≥15.
    inner.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result;
    try {
      result = await Promise.race([
        inner,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const elapsed = Date.now() - start;
            log('fetch:timeout', { url, elapsed, role: this.inner.role });
            const err = new FetchproxyTimeoutError({
              url,
              timeoutMs: this.fetchTimeoutMs,
              elapsedMs: elapsed,
              role: this.inner.role,
              port: this.port,
            });
            this.recordFailure(`timeout: ${url}`);
            reject(err);
          }, this.fetchTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const elapsed = Date.now() - start;
    if (!result.ok) {
      log('fetch:bridge-error', { url, elapsed, error: result.error });
      // @fetchproxy/server 0.5.0+ classifies the extension-side error
      // into a discriminated `kind` (`'content_script_unreachable'`,
      // `'no_tab'`, `'tab_fetch_failed'`, …). We surface the SW-
      // unreachable case as a typed FetchproxyBridgeDownError so
      // callers + redfin_healthcheck can give actionable hints.
      //
      // NOTE: bridge-down does NOT recordFailure here — the lazy-revive
      // retry in `fetch()` owns that accounting so a single user-visible
      // failure increments `consecutiveFailures` by exactly 1.
      if (result.kind === 'content_script_unreachable') {
        throw new FetchproxyBridgeDownError({
          url,
          elapsedMs: elapsed,
          role: this.inner.role,
          port: this.port,
          originalError: result.error,
        });
      }
      this.recordFailure(result.error);
      throw new Error(
        `fetchproxy transport error after ${elapsed}ms (role=${this.inner.role ?? 'null'}): ${result.error}`
      );
    }
    log('fetch:done', {
      url,
      elapsed,
      status: result.status,
      bodyLen: result.body.length,
    });
    this.recordSuccess();
    return { status: result.status, body: result.body, url: result.url };
  }
}
