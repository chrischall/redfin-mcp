import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetSessionsForTest,
  ensureDefaultSession,
  getActiveSessionId,
  listSessions,
  registerSession,
  setActiveSession,
  UnknownSessionError,
} from '../src/sessions.js';

describe('session registry', () => {
  beforeEach(() => _resetSessionsForTest());

  it('starts with no sessions and no active id', () => {
    expect(listSessions()).toEqual([]);
    expect(getActiveSessionId()).toBeNull();
  });

  it('first registration becomes the active session', () => {
    const s = registerSession('personal');
    expect(s.session_id).toMatch(/^s_/);
    expect(s.account_label).toBe('personal');
    expect(s.auth_mode).toBe('browser_bridge');
    expect(getActiveSessionId()).toBe(s.session_id);
    expect(listSessions()).toHaveLength(1);
  });

  it('subsequent registrations are additive, do NOT switch active', () => {
    const a = registerSession('personal');
    const b = registerSession('shared');
    expect(listSessions()).toHaveLength(2);
    expect(getActiveSessionId()).toBe(a.session_id);
    expect(b.session_id).not.toBe(a.session_id);
  });

  it('setActiveSession switches to a registered id', () => {
    const a = registerSession('personal');
    const b = registerSession('shared');
    setActiveSession(b.session_id);
    expect(getActiveSessionId()).toBe(b.session_id);
    setActiveSession(a.session_id);
    expect(getActiveSessionId()).toBe(a.session_id);
  });

  it('setActiveSession throws UnknownSessionError for unknown id', () => {
    expect(() => setActiveSession('nope')).toThrow(UnknownSessionError);
  });

  it('ensureDefaultSession creates one when empty, no-op otherwise', () => {
    const created = ensureDefaultSession();
    expect(created.account_label).toContain('default');
    expect(listSessions()).toHaveLength(1);
    // Idempotent — calling again returns the active one without
    // adding more rows.
    const same = ensureDefaultSession();
    expect(same.session_id).toBe(created.session_id);
    expect(listSessions()).toHaveLength(1);
  });

  it('listSessions returns oldest-first by registered_at', async () => {
    const a = registerSession('a');
    // Tiny wait so the next session has a strictly later timestamp.
    await new Promise((r) => setTimeout(r, 2));
    const b = registerSession('b');
    const list = listSessions();
    expect(list.map((s) => s.session_id)).toEqual([a.session_id, b.session_id]);
  });
});
