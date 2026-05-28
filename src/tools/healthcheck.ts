import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedfinClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '../transport-fetchproxy.js';

/**
 * Round-trip a no-op request through the full bridge so the user can
 * tell — with ONE tool call, without needing a real search — whether:
 *
 *   - redfin-mcp's WebSocket bridge is up (`bridge.role` non-null)
 *   - the fetchproxy browser extension is connected (request reaches
 *     a tab and a response comes back)
 *   - the active redfin.com tab is responsive (the fetch resolved
 *     within the timeout)
 *
 * Probe target: `/robots.txt` on redfin.com. It's small, public (no
 * auth needed), and served from Redfin's edge — so a failure here
 * cleanly isolates the bridge from redfin.com's own auth/SSR pipeline.
 * If `/robots.txt` round-trips OK but the real search still hangs, the
 * problem is downstream of fetchproxy (Redfin redirecting on login,
 * behavioral challenge, etc.); if `/robots.txt` fails, the bridge or
 * extension is the issue.
 */

interface HealthcheckResult {
  ok: boolean;
  bridge: {
    role: 'host' | 'peer' | null;
    port: number;
    server_version: string;
    fetch_timeout_ms: number;
    /** Unix-ms timestamp of the last successful round-trip. `null` until the first success. */
    last_success_at: number | null;
    /** Unix-ms timestamp of the last failed round-trip. `null` until the first failure. */
    last_failure_at: number | null;
    /** Most recent failure reason. `null` until the first failure. */
    last_failure_reason: string | null;
    /** Count of failures since the last success (or process start, if none). */
    consecutive_failures: number;
  };
  probe: {
    url: string;
    elapsed_ms: number;
    status?: number;
    body_length?: number;
  };
  error?: {
    kind: 'timeout' | 'transport' | 'bridge_down' | 'other';
    message: string;
    /** Role the bridge was in at throw time. Read directly off the typed
     *  error (0.8.0+); previously snapshotted post-throw via
     *  `bridgeStatus()`, which was racy on quick reconnects. */
    role_at_failure?: 'host' | 'peer' | null;
    /** 0.8.0+: actual elapsed ms when a `FetchproxyTimeoutError` fired.
     *  Lets users distinguish a hair-trigger timeout from a real hang. */
    elapsed_ms_at_timeout?: number;
    /** 0.8.0+: pre-built actionable recovery string from
     *  `FetchproxyBridgeDownError.hint` (e.g. "click the extension icon
     *  to wake the service worker"). Surfaced so the LLM can show the
     *  user the upstream recommendation verbatim. */
    bridge_hint?: string;
  };
  /** Plain-English next-step suggestion derived from the result. */
  hint: string;
}

const PROBE_PATH = '/robots.txt';

function hintFor(args: {
  ok: boolean;
  role: 'host' | 'peer' | null;
  errorKind?: 'timeout' | 'transport' | 'bridge_down' | 'other';
}): string {
  if (args.ok) {
    return `Bridge round-tripped /robots.txt successfully. If real tools still hang, the problem is downstream of fetchproxy (Redfin redirecting on login, behavioral challenge, etc.) — not the bridge.`;
  }
  // Order: specific error kinds first, then the generic role-based hint.
  // A FetchproxyBridgeDownError can fire with role=null (the bridge can
  // hand back the SW-eviction error before listen() has resolved); the
  // more-specific bridge_down hint must win over the generic
  // "never bound a role" message in that case.
  if (args.errorKind === 'bridge_down') {
    return `The fetchproxy browser extension's service worker is not responding. Chrome evicts extension service workers after ~30s idle by default — this looks like that case. Wake it by clicking the fetchproxy extension icon (or opening any redfin.com tab and reloading), then retry. If it keeps happening, reload the extension from chrome://extensions.`;
  }
  if (args.role === null) {
    return `The bridge never bound a role. listen() may have failed silently on startup. Check stderr from redfin-mcp for an error during start, and confirm port ${37149} isn't blocked.`;
  }
  if (args.errorKind === 'timeout') {
    return `Bridge is alive (role=${args.role}), but the request didn't get a response in time. Either (a) the fetchproxy browser extension isn't connected to this MCP yet — open the extension popup and check for a green dot next to "redfin-mcp", or (b) the signed-in redfin.com tab is sleeping / closed. Open redfin.com in your browser, then retry.`;
  }
  if (args.errorKind === 'transport') {
    return `The bridge returned a protocol error before any HTTP response. Most commonly: no redfin.com tab is open, or the extension declined the request. Open redfin.com, sign in, and retry.`;
  }
  return `Unexpected error — see the error.message field for details.`;
}

export function registerHealthcheckTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_healthcheck',
    {
      title: 'Verify the fetchproxy bridge end-to-end',
      description:
        "Round-trips a small public Redfin URL (/robots.txt) through the fetchproxy bridge and returns diagnostics: the bridge's role (host/peer/null), port, version, the elapsed round-trip time, and a plain-English hint that distinguishes 'bridge never came up' from 'extension not connected' from 'real Redfin-side problem'. Call this when a real Redfin tool times out and you want to know which hop failed. Read-only, no auth required.",
      annotations: {
        title: 'Verify the fetchproxy bridge end-to-end',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      // 0.10.0+: the transport half of the probe — run the fetch, time
      // it, classify any thrown error, and project the POST-probe
      // bridgeHealth() (so the freshness counters reflect this very
      // call) — now lives in `@fetchproxy/server`'s `runProbe`. We pass
      // `client.fetchHtml` as the probe fn so Redfin's own non-2xx /
      // sign-in guards still fire inside the round-trip, and capture the
      // body length (success) and the thrown typed error (failure) in
      // the closure so we can surface the Redfin-specific extras
      // (`body_length`, `role_at_failure`, `elapsed_ms_at_timeout`,
      // `bridge_hint`) that `runProbe` doesn't carry on its own.
      let bodyLength = 0;
      let thrown: unknown;
      const probeResult = await client.runProbe(async (path) => {
        try {
          const html = await client.fetchHtml(path);
          bodyLength = html.length;
          return html;
        } catch (e) {
          thrown = e;
          throw e;
        }
      }, PROBE_PATH);

      const bridge = probeResult.bridge;
      const probe: HealthcheckResult['probe'] = probeResult.ok
        ? {
            url: `https://www.redfin.com${PROBE_PATH}`,
            elapsed_ms: probeResult.elapsed_ms,
            status: 200, // fetchHtml throws on non-2xx; ok means 2xx
            body_length: bodyLength,
          }
        : {
            url: `https://www.redfin.com${PROBE_PATH}`,
            elapsed_ms: probeResult.elapsed_ms,
          };

      let error: HealthcheckResult['error'];
      if (probeResult.error) {
        // `runProbe` classifies via the same `classifyBridgeError` helper
        // ("subclass before parent" once), so we just branch on its kind.
        // The typed-error extras (role / elapsedMs / hint) come off the
        // error we captured in the probe fn above.
        const { kind, message } = probeResult.error;
        switch (kind) {
          case 'timeout': {
            const te = thrown as FetchproxyTimeoutError;
            error = {
              kind: 'timeout',
              message,
              role_at_failure: te.role,
              elapsed_ms_at_timeout: te.elapsedMs,
            };
            break;
          }
          case 'bridge_down': {
            const bd = thrown as FetchproxyBridgeDownError;
            error = {
              kind: 'bridge_down',
              message,
              role_at_failure: bd.role,
              bridge_hint: bd.hint,
            };
            break;
          }
          case 'http':
          case 'protocol':
            // redfin-mcp doesn't pass `expectStatus`, so FetchproxyHttpError
            // shouldn't fire in practice; bucket it with generic protocol
            // failures (no-tab, tab-fetch-failed, etc.) so the user still
            // gets the "open redfin.com, sign in, and retry" hint.
            error = { kind: 'transport', message };
            break;
          case 'other':
          default:
            error = { kind: 'other', message };
            break;
        }
      }

      const result: HealthcheckResult = {
        ok: probeResult.ok,
        bridge: {
          role: bridge.role,
          port: bridge.port,
          server_version: bridge.server_version,
          fetch_timeout_ms: bridge.fetch_timeout_ms,
          last_success_at: bridge.last_success_at,
          last_failure_at: bridge.last_failure_at,
          last_failure_reason: bridge.last_failure_reason,
          consecutive_failures: bridge.consecutive_failures,
        },
        probe,
        ...(error ? { error } : {}),
        hint: hintFor({
          ok: probeResult.ok,
          role: bridge.role,
          errorKind: error?.kind,
        }),
      };
      return textResult(result);
    }
  );
}
