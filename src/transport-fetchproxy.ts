// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// redfin-mcp's RedfinTransport interface.
//
// As of @fetchproxy/server 0.8.0, lazy-revive on Chrome MV3
// service-worker eviction (default 2000ms) and per-request timeouts
// (default 30000ms) are server defaults. The convenience `request()`
// method throws typed `FetchproxyBridgeDownError` /
// `FetchproxyTimeoutError` on failure (both subclasses of
// `FetchproxyProtocolError`).
//
// What this layer DOES instrument (boundary visibility):
//   - The `role` (host vs peer) the FetchproxyServer landed in after
//     `listen()`. Logged once to stderr on startup.
//   - Per-request timing around `this.inner.request(...)` when
//     REDFIN_DEBUG=1 is set in the env.
//
// What this layer CAN'T instrument (lives upstream in
// https://github.com/chrischall/fetchproxy):
//   - Service worker wake-up + message-listener binding
//   - Content-script injection on the active tab
//   - Tab selection (which redfin.com tab the SW picked)
//   - The window.fetch() that actually runs in the page

import {
  FetchproxyServer,
  type FetchproxyServerOpts,
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyProtocolError,
} from '@fetchproxy/server';
import type {
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
};

const DEFAULT_PORT = 37_149;
// Server default; mirrored here so `status().fetchTimeoutMs` stays accurate.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

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
  /** Per-request timeout in ms. Default 30s. */
  fetchTimeoutMs?: number;
}

export class FetchproxyTransport implements RedfinTransport {
  private readonly inner: FetchproxyServer;
  private readonly fetchTimeoutMs: number;
  private readonly port: number;
  private readonly serverVersion: string;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'redfin-mcp',
      version: opts.version,
      // Subdomains of redfin.com (www, photos, etc.) match automatically.
      domains: ['redfin.com'],
      fetchTimeoutMs: this.fetchTimeoutMs,
    };
    this.inner = new FetchproxyServer(options);
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
   * 0.8.0+: BridgeStatus is now an alias for the server's BridgeHealth,
   * so the shim collapses to a direct delegation.
   */
  status(): BridgeStatus {
    return this.inner.bridgeHealth();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const start = Date.now();
    log('fetch:start', {
      method: init.method,
      path: init.path,
      role: this.inner.role,
      port: this.port,
    });
    // 0.8.0+: `request()` throws FetchproxyBridgeDownError on persistent
    // SW eviction (after the server's one-shot lazy-revive retry) and
    // FetchproxyTimeoutError on fetchTimeoutMs. Both subclass
    // FetchproxyProtocolError so any caller catching the parent matches.
    const response = await this.inner.request(init.method, init.path, {
      subdomain: 'www',
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
}
