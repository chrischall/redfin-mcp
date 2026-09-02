import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBridgeHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import type { RedfinClient } from '../client.js';

/**
 * `redfin_healthcheck` — the fleet-shared bridge healthcheck from
 * `@chrischall/mcp-utils/fetchproxy`, parameterised for Redfin.
 *
 * Round-trips `/robots.txt` on www.redfin.com through the full bridge so
 * the user can tell — with ONE tool call, without needing a real search —
 * whether the WebSocket bridge is up (`bridge.role`), the Transporter
 * extension is linked (`bridge.session_state` / `pending_pair_code` /
 * `extension_connected` / `last_extension_message_at`), and the active
 * redfin.com tab is responsive (the fetch resolved within the timeout).
 *
 * `/robots.txt` is small, public (no auth needed), and served from
 * Redfin's edge — so a failure here cleanly isolates the bridge from
 * redfin.com's own auth/SSR pipeline. If it round-trips OK but a real
 * tool still hangs, the problem is downstream of fetchproxy (Redfin
 * redirecting on login, behavioral challenge, etc.); if it fails, the
 * bridge, the extension link, or the tab is the issue.
 *
 * The probe runs through `client.fetchHtml` so Redfin's own non-2xx /
 * sign-in guards fire inside the round-trip, exactly as real tools see
 * them. The probe loop, error classification (`timeout` / `bridge_down` /
 * `session_not_ready` / `protocol` / `http` / `unknown`), post-probe
 * bridge projection, and the hint ladder all live upstream; only the
 * Redfin-specific bits are set here.
 */

const PROBE_PATH = '/robots.txt';
const HOST_LABEL = 'www.redfin.com';

export function registerHealthcheckTools(
  server: McpServer,
  client: RedfinClient
): void {
  registerBridgeHealthcheckTool({
    server,
    prefix: 'redfin',
    probePath: PROBE_PATH,
    hostLabel: HOST_LABEL,
    // The client owns the transport; expose just the two verbs the shared
    // healthcheck drives so `registerHealthcheckTools(server, client)`
    // keeps its signature for index.ts.
    transport: {
      runProbe: (fetchFn, probePath) => client.runProbe(fetchFn, probePath),
      status: () => client.bridgeStatus(),
    },
    probeFn: (path) => client.fetchHtml(path),
    hints: {
      // The shared copy interpolates `hostLabel` (www.redfin.com); keep the
      // bare-domain phrasing the Redfin guidance has always used.
      protocol:
        'The bridge returned a protocol error before any HTTP response. Most commonly: no redfin.com tab is open, or the extension declined the request. Open redfin.com, sign in, and retry.',
    },
  });
}
