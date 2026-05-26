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
    /** When the timeout fired, the role at the moment of failure. */
    role_at_failure?: 'host' | 'peer' | null;
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
      // We read bridgeStatus() once at the bottom (after the probe) so
      // the freshness counters in the response include this very call.
      // Don't read it up front — that snapshot would be stale.
      const start = Date.now();
      let probe: HealthcheckResult['probe'] = {
        url: `https://www.redfin.com${PROBE_PATH}`,
        elapsed_ms: 0,
      };
      let error: HealthcheckResult['error'];
      let ok = false;
      try {
        const html = await client.fetchHtml(PROBE_PATH);
        probe = {
          url: `https://www.redfin.com${PROBE_PATH}`,
          elapsed_ms: Date.now() - start,
          status: 200, // fetchHtml throws on non-2xx; reaching here means 2xx
          body_length: html.length,
        };
        ok = true;
      } catch (e) {
        const elapsedMs = Date.now() - start;
        if (e instanceof FetchproxyTimeoutError) {
          error = {
            kind: 'timeout',
            message: e.message,
            role_at_failure: e.role,
          };
        } else if (e instanceof FetchproxyBridgeDownError) {
          error = {
            kind: 'bridge_down',
            message: e.message,
            role_at_failure: e.role,
          };
        } else if (e instanceof Error && /fetchproxy transport error/.test(e.message)) {
          error = { kind: 'transport', message: e.message };
        } else {
          error = {
            kind: 'other',
            message: e instanceof Error ? e.message : String(e),
          };
        }
        probe = { ...probe, elapsed_ms: elapsedMs };
      }
      // Re-read after the probe — recordSuccess/recordFailure on the
      // transport just updated the counters, so this snapshot reflects
      // the freshest state including this very call.
      const postProbeBridge = client.bridgeStatus();
      const result: HealthcheckResult = {
        ok,
        bridge: {
          role: postProbeBridge.role,
          port: postProbeBridge.port,
          server_version: postProbeBridge.serverVersion,
          fetch_timeout_ms: postProbeBridge.fetchTimeoutMs,
          last_success_at: postProbeBridge.lastSuccessAt,
          last_failure_at: postProbeBridge.lastFailureAt,
          last_failure_reason: postProbeBridge.lastFailureReason,
          consecutive_failures: postProbeBridge.consecutiveFailures,
        },
        probe,
        ...(error ? { error } : {}),
        hint: hintFor({
          ok,
          role: postProbeBridge.role,
          errorKind: error?.kind,
        }),
      };
      return textResult(result);
    }
  );
}
