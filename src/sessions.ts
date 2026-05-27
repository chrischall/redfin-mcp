/**
 * Multi-session registry for Redfin sign-ins.
 *
 * Redfin's auth lives in the user's Chrome cookie jar — every request
 * rides through the fetchproxy bridge to a signed-in tab. The browser
 * is effectively a single-session lane today, but operators with
 * multiple Redfin accounts (personal + shared + agent) want a stable
 * handle they can flip between without re-authing.
 *
 * The registry models a `session_id` as a CALLER-VISIBLE LABEL only.
 * It does NOT switch the browser tab's signed-in account. The active
 * session_id is recorded so future routing infrastructure (per-tab
 * dispatch, separate Chrome profiles) can hook in here without
 * breaking the public API. See issue #39 / #40.
 *
 * Today every registered session shares the same bridge connection.
 * The label exists so callers can record "I'm reading data for
 * `chris@example.com`" alongside the response and reason about
 * cross-session workflows even when the underlying connection is one.
 */

export interface RegisteredSession {
  session_id: string;
  /** Optional human-readable label (e.g. "personal", "shared"). */
  account_label?: string;
  /** Auth mode — fixed to `browser_bridge` today; future modes
   * (bearer-token, separate Chrome profile) will live here. */
  auth_mode: 'browser_bridge';
  /** Always `true` while the bridge is up — the actual signed-in
   * state lives in the browser tab and isn't directly observable
   * from this process. */
  auth_ready: boolean;
  /** Unix-ms when this session was registered. */
  registered_at: number;
}

let sessions: Map<string, RegisteredSession> = new Map();
let activeSessionId: string | null = null;

/** Reset the registry. Test-only — production code never calls this. */
export function _resetSessionsForTest(): void {
  sessions = new Map();
  activeSessionId = null;
}

function generateSessionId(): string {
  // Short, opaque label; collisions are vanishingly unlikely within a
  // process lifetime and the alternative (uuid lib) isn't worth the
  // dep for a per-process registry.
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Register a new session. The first registration becomes the active
 * one. Subsequent registrations are additive — call
 * `setActiveSession(id)` to switch.
 */
export function registerSession(account_label?: string): RegisteredSession {
  const session_id = generateSessionId();
  const entry: RegisteredSession = {
    session_id,
    account_label,
    auth_mode: 'browser_bridge',
    auth_ready: true,
    registered_at: Date.now(),
  };
  sessions.set(session_id, entry);
  if (!activeSessionId) activeSessionId = session_id;
  return entry;
}

export class UnknownSessionError extends Error {
  constructor(id: string) {
    super(`Unknown session_id "${id}". Register one with redfin_register_session or list them with redfin_get_session_context.`);
    this.name = 'UnknownSessionError';
  }
}

/**
 * Make `session_id` the active session for subsequent tool calls.
 * Throws `UnknownSessionError` for unregistered IDs.
 */
export function setActiveSession(session_id: string): void {
  if (!sessions.has(session_id)) throw new UnknownSessionError(session_id);
  activeSessionId = session_id;
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

export function listSessions(): RegisteredSession[] {
  return Array.from(sessions.values()).sort(
    (a, b) => a.registered_at - b.registered_at
  );
}

/**
 * Ensure at least one session is present so the diagnostic tool can
 * report a stable shape. The default session uses the browser bridge
 * — the auth state lives in the user's Chrome tab.
 */
export function ensureDefaultSession(): RegisteredSession {
  if (sessions.size === 0) {
    return registerSession('default (browser bridge)');
  }
  return sessions.get(activeSessionId!)!;
}
