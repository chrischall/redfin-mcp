// Transport-agnostic interface for the bridge that relays Redfin
// fetches through the user's real Chrome session.
//
// The default implementation in src/transport-fetchproxy.ts wraps
// @fetchproxy/server's FetchproxyServer (127.0.0.1:37149 WebSocket).
//
// RedfinClient (src/client.ts) accepts any RedfinTransport. Error
// mapping (non-2xx, sign-in interstitial, 204 → null) lives on the
// client, not the transport — every implementation only has to round-
// trip the request and return a {status, body, url} triple.

export interface FetchInit {
  /** Path-and-query relative to https://www.redfin.com, e.g.
   *  `/homedetails/.../12345_zpid/` or `/async-create-search-page-state/`. */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** Serialized request body. JSON callers stringify before calling.
   *  Omitted for GETs. */
  body?: string;
}

export interface FetchResult {
  status: number;
  /** Response body as a string. Empty string for 204. */
  body: string;
  /** Final URL after redirects. Used for sign-in-page detection. */
  url: string;
}

/** Diagnostic snapshot returned by `RedfinTransport.status()`. */
export interface BridgeStatus {
  /** Role the underlying server elected (host vs peer). `null` until `start()` resolves. */
  role: 'host' | 'peer' | null;
  /** The WebSocket port. Hosts bind it; peers tunnel through it. */
  port: number;
  /** MCP server version announced to the extension. */
  serverVersion: string;
  /** Default per-request timeout in ms. */
  fetchTimeoutMs: number;
  /** Unix-ms timestamp of the last successful round-trip. `null` until the first success. */
  lastSuccessAt: number | null;
  /** Unix-ms timestamp of the last failed round-trip. `null` until the first failure. */
  lastFailureAt: number | null;
  /** Short message describing the most recent failure. `null` until the first failure. */
  lastFailureReason: string | null;
  /** Number of failures since the last success (or since process start, if none). */
  consecutiveFailures: number;
}

export interface RedfinTransport {
  /** Bring the transport up. Idempotent. */
  start(): Promise<void>;

  /** Tear the transport down. Idempotent. */
  close(): Promise<void>;

  /** Round-trip one request through the bridge. Resolves to a result
   *  triple even for non-2xx statuses — the client maps HTTP errors. */
  fetch(init: FetchInit): Promise<FetchResult>;

  /** Diagnostic snapshot of the bridge. Safe to call any time. */
  status(): BridgeStatus;
}
