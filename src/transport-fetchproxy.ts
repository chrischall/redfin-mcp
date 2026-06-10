// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// redfin-mcp's RedfinTransport interface.
//
// The verb surface (fetch / runProbe / status / start / close) is now the
// shared `createFetchproxyTransport` from @chrischall/mcp-utils/fetchproxy
// (0.8+ verb adapters). It owns the request assembly (subdomain default,
// header/body passthrough, {status, body, url} projection), the runProbe
// passthrough, and the bridgeHealth() snapshot — the same hand-rolled
// methods redfin / homes / compass / musescore each wrote verbatim. This
// thin class keeps only the redfin-specific startup banner + REDFIN_DEBUG
// per-request timing, and the named export so index.ts / downstream
// importers are unchanged.
//
// As of @fetchproxy/server 0.8.0 (carried forward in 1.x), lazy-revive
// on Chrome MV3 service-worker eviction (default 2000ms) and per-request
// timeouts (default 30000ms) are server defaults — we no longer pass
// them explicitly unless a caller overrides. The convenience `request()`
// method throws typed `FetchproxyBridgeDownError` /
// `FetchproxyTimeoutError` on failure (both subclasses of
// `FetchproxyProtocolError`).
//
// What this layer DOES instrument (boundary visibility):
//   - The `role` (host vs peer) the FetchproxyServer landed in after
//     `listen()`. Logged once to stderr on startup.
//   - Per-request timing around the verb `fetch(...)` when
//     REDFIN_DEBUG=1 is set in the env.
//
// What this layer CAN'T instrument (lives upstream in
// https://github.com/chrischall/fetchproxy):
//   - Service worker wake-up + message-listener binding
//   - Content-script injection on the active tab
//   - Tab selection (which redfin.com tab the SW picked)
//   - The window.fetch() that actually runs in the page

import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyVerbTransport,
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyProtocolError,
  classifyBridgeError,
  type BridgeError,
} from '@chrischall/mcp-utils/fetchproxy';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchInit,
  FetchResult,
  RedfinTransport,
} from './transport.js';

// Re-exported so downstream callers (healthcheck, future tools) can
// still `import { FetchproxyBridgeDownError } from './transport-fetchproxy.js'`.
export {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyProtocolError,
  classifyBridgeError,
};
export type { BridgeError };

const DEFAULT_PORT = 37_149;

const DEBUG = process.env.REDFIN_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[redfin-mcp:bridge]', ...args);
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'redfin-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
  /** Per-request timeout in ms. Omit to use the server's 30s default. */
  fetchTimeoutMs?: number;
}

export class FetchproxyTransport implements RedfinTransport {
  private readonly inner: FetchproxyVerbTransport;
  private readonly port: number;
  private readonly serverVersion: string;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    this.inner = createFetchproxyTransport<FetchproxyVerbTransport>({
      port: this.port,
      serverName: opts.server ?? 'redfin-mcp',
      version: opts.version,
      // Subdomains of redfin.com (www, photos, etc.) match automatically.
      domains: ['redfin.com'],
      // The verb adapters apply subdomain 'www' per call unless overridden —
      // matches the hand-rolled `{ subdomain: 'www' }` redfin passed before.
      defaultSubdomain: 'www',
      // 1.x defaults `fetchTimeoutMs` to 30_000 — only forward when a
      // caller explicitly overrides.
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
      // 1.x defaults `keepAliveIntervalMs` to 25_000ms (fetchproxy#72) — the
      // whole consumer cohort had been opting into exactly this value, so we
      // no longer pass it explicitly. Keeps the SW resident across
      // human-paced session gaps, same as before.
    });
  }

  async start(): Promise<void> {
    log('listen start', { port: this.port, version: this.serverVersion });
    await this.inner.start();
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
   * 0.8.0+: BridgeStatus is now an alias for the server's BridgeHealth,
   * so the shim collapses to a direct delegation.
   */
  status(): BridgeStatus {
    return this.inner.status();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const start = Date.now();
    log('fetch:start', {
      method: init.method,
      path: init.path,
      role: this.inner.role,
      port: this.port,
    });
    // The verb adapter applies `defaultSubdomain: 'www'` and throws
    // FetchproxyBridgeDownError on persistent SW eviction (after the
    // server's one-shot lazy-revive retry) and FetchproxyTimeoutError on
    // fetchTimeoutMs. Both subclass FetchproxyProtocolError so any caller
    // catching the parent matches.
    const response = await this.inner.fetch({
      method: init.method,
      path: init.path,
      headers: init.headers,
      body: init.body,
    });
    const elapsed = Date.now() - start;
    log('fetch:done', {
      path: init.path,
      elapsed,
      status: response.status,
      bodyLen: response.body.length,
    });
    return { status: response.status, body: response.body, url: response.url };
  }

  /**
   * 0.10.0+: delegate to the verb adapter's `runProbe`, which owns the probe
   * execution + elapsed timing + error classification + post-probe
   * `bridgeHealth()` projection. The healthcheck tool keeps its own
   * Redfin-specific hint text.
   */
  async runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
