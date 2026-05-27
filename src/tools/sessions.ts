import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../mcp.js';
import {
  ensureDefaultSession,
  getActiveSessionId,
  listSessions,
  registerSession,
  setActiveSession,
} from '../sessions.js';

/**
 * Session-management tool surface. See `src/sessions.ts` for the
 * registry — these tools just expose the registry to callers.
 *
 * The auth model is the user's signed-in Chrome session, dispatched
 * through fetchproxy. A "registered session" is a caller-visible
 * label only; switching the active session does NOT switch the signed-in
 * account in the browser. Multi-account workflows that need
 * truly distinct cookie jars are tracked separately. See issue #39 / #40.
 */

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'redfin_get_session_context',
    {
      title: 'List registered Redfin sessions and the active one',
      description:
        "Diagnostic snapshot of the Redfin session registry. Returns `{active_session_id, sessions: [{session_id, account_label?, auth_mode, auth_ready, registered_at}, ...]}`. The shape is consistent whether one session is registered (today's common path) or many — callers can iterate `sessions[]` unconditionally. Today every session rides the same Chrome browser-bridge connection; the label is for caller-side bookkeeping (which account a workflow is using). Read-only, no side effects.",
      annotations: {
        title: 'List registered Redfin sessions and the active one',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => {
      ensureDefaultSession();
      return textResult({
        active_session_id: getActiveSessionId(),
        sessions: listSessions(),
      });
    }
  );

  server.registerTool(
    'redfin_register_session',
    {
      title: 'Register an additional Redfin session label',
      description:
        "Register a new session_id alongside any existing ones. Use this when running a workflow against a specific Redfin account (e.g. personal vs shared) and you want a stable handle for it. The first registration becomes the active session automatically; subsequent calls are additive — switch with `redfin_set_active_session`. NOTE: today every session shares the same browser-bridge connection — the label is bookkeeping, not a separate sign-in. True per-account isolation is a future change.",
      annotations: {
        title: 'Register an additional Redfin session label',
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        account_label: z
          .string()
          .optional()
          .describe('Optional human-readable label (e.g. "personal", "shared", "agent").'),
      },
    },
    async ({ account_label }) => {
      const entry = registerSession(account_label);
      return textResult({
        registered: entry,
        active_session_id: getActiveSessionId(),
      });
    }
  );

  server.registerTool(
    'redfin_set_active_session',
    {
      title: 'Switch the active Redfin session',
      description:
        "Make `session_id` the active session for subsequent tool calls. Use this when more than one session is registered. Errors with `UnknownSessionError` for IDs not in the registry — list them via `redfin_get_session_context` first.",
      annotations: {
        title: 'Switch the active Redfin session',
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        session_id: z
          .string()
          .describe('A previously-registered session_id (see redfin_get_session_context).'),
      },
    },
    async ({ session_id }) => {
      setActiveSession(session_id);
      return textResult({
        active_session_id: getActiveSessionId(),
      });
    }
  );
}
