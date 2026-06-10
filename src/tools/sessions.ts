import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerSessionTools as registerSharedSessionTools,
  type SessionRegistry,
} from '@chrischall/mcp-utils/session';

/**
 * MCP tool surface for the Redfin session registry.
 *
 * - `redfin_register_session` — adds (or refreshes) an authenticated
 *   session keyed by `account_identity`.
 * - `redfin_set_active_session` — explicitly switch which session
 *   subsequent calls route through.
 * - `redfin_get_session_context` — returns the full registry plus
 *   `active_session_id`.
 *
 * The trio is the fleet-shared `registerSessionTools` from
 * `@chrischall/mcp-utils/session`, bound to the `redfin` prefix. It's
 * wrapped here (rather than called directly in index.ts) so the
 * `redfin`-specific prefix lives in one place and the existing
 * `(server, registry)` call site stays unchanged.
 *
 * The auth model is the user's signed-in Chrome session, dispatched
 * through fetchproxy. A "registered session" is a caller-visible label
 * only; switching the active session does NOT switch the signed-in
 * account in the browser. See issue #39 / #40.
 */
export function registerSessionTools(
  server: McpServer,
  registry: SessionRegistry
): void {
  registerSharedSessionTools(server, registry, {
    prefix: 'redfin',
    serviceLabel: 'Redfin',
  });
}
