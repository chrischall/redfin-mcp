import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { _resetSessionsForTest } from '../../src/sessions.js';
import { registerSessionTools } from '../../src/tools/sessions.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => _resetSessionsForTest());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('session tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerSessionTools(server));
  });

  it('redfin_get_session_context auto-creates a default session on first call', async () => {
    const r = await harness.callTool('redfin_get_session_context', {});
    const parsed = parseToolResult<{
      active_session_id: string;
      sessions: Array<{ session_id: string; account_label?: string }>;
    }>(r);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].account_label).toContain('default');
    expect(parsed.active_session_id).toBe(parsed.sessions[0].session_id);
  });

  it('redfin_register_session adds a new session without switching active', async () => {
    await harness.callTool('redfin_get_session_context', {}); // creates default
    const r = await harness.callTool('redfin_register_session', {
      account_label: 'shared',
    });
    const parsed = parseToolResult<{
      registered: { session_id: string; account_label: string };
      active_session_id: string;
    }>(r);
    expect(parsed.registered.account_label).toBe('shared');
    // Active stays as the first-registered (default), not the new one.
    expect(parsed.active_session_id).not.toBe(parsed.registered.session_id);

    const ctx = await harness.callTool('redfin_get_session_context', {});
    const parsedCtx = parseToolResult<{
      active_session_id: string;
      sessions: Array<{ session_id: string }>;
    }>(ctx);
    expect(parsedCtx.sessions).toHaveLength(2);
  });

  it('redfin_set_active_session switches the active id', async () => {
    await harness.callTool('redfin_register_session', { account_label: 'a' });
    const b = await harness.callTool('redfin_register_session', {
      account_label: 'b',
    });
    const parsedB = parseToolResult<{ registered: { session_id: string } }>(b);
    const r = await harness.callTool('redfin_set_active_session', {
      session_id: parsedB.registered.session_id,
    });
    const parsed = parseToolResult<{ active_session_id: string }>(r);
    expect(parsed.active_session_id).toBe(parsedB.registered.session_id);
  });

  it('redfin_set_active_session errors on unknown session_id', async () => {
    const r = await harness.callTool('redfin_set_active_session', {
      session_id: 'definitely-not-real',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/Unknown session_id/);
  });
});
