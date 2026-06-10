import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createSessionRegistry } from '@chrischall/mcp-utils/session';
import { registerSessionTools } from '../../src/tools/sessions.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>>;
// One registry instance closure-captured by the harness; reset between tests
// so state never leaks (the harness is built once in `setup`).
const registry = createSessionRegistry();

beforeEach(() => registry.reset());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('session tools (shared registry)', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSessionTools(server, registry)
    );
  });

  it('redfin_get_session_context starts empty (no auto-default)', async () => {
    const r = await harness.callTool('redfin_get_session_context', {});
    const parsed = parseToolResult<{
      active_session_id: string | null;
      sessions: Array<{ session_id: string; account_identity?: string }>;
    }>(r);
    expect(parsed.sessions).toHaveLength(0);
    expect(parsed.active_session_id).toBeNull();
  });

  it('redfin_register_session registers a session keyed by account_identity', async () => {
    const r = await harness.callTool('redfin_register_session', {
      account_identity: 'chris@example.com',
    });
    const parsed = parseToolResult<{
      session: { session_id: string; account_identity: string };
      active_session_id: string;
    }>(r);
    expect(parsed.session.account_identity).toBe('chris@example.com');
    // First registered session becomes the active one.
    expect(parsed.active_session_id).toBe(parsed.session.session_id);
  });

  it('re-registering the same account_identity updates in place', async () => {
    const first = parseToolResult<{ session: { session_id: string } }>(
      await harness.callTool('redfin_register_session', {
        account_identity: 'chris@example.com',
      })
    );
    const second = parseToolResult<{ session: { session_id: string } }>(
      await harness.callTool('redfin_register_session', {
        account_identity: 'chris@example.com',
      })
    );
    expect(second.session.session_id).toBe(first.session.session_id);

    const ctx = parseToolResult<{ sessions: unknown[] }>(
      await harness.callTool('redfin_get_session_context', {})
    );
    expect(ctx.sessions).toHaveLength(1);
  });

  it('a second account_identity is additive and does NOT switch active', async () => {
    const a = parseToolResult<{ session: { session_id: string } }>(
      await harness.callTool('redfin_register_session', {
        account_identity: 'personal@example.com',
      })
    );
    const b = parseToolResult<{
      session: { session_id: string };
      active_session_id: string;
    }>(
      await harness.callTool('redfin_register_session', {
        account_identity: 'shared@example.com',
      })
    );
    expect(b.session.session_id).not.toBe(a.session.session_id);
    expect(b.active_session_id).toBe(a.session.session_id);

    const ctx = parseToolResult<{ sessions: unknown[] }>(
      await harness.callTool('redfin_get_session_context', {})
    );
    expect(ctx.sessions).toHaveLength(2);
  });

  it('account_identity is required (rejects missing/empty)', async () => {
    const missing = await harness.callTool('redfin_register_session', {});
    expect(missing.isError).toBeTruthy();
    const empty = await harness.callTool('redfin_register_session', {
      account_identity: '',
    });
    expect(empty.isError).toBeTruthy();
  });

  it('redfin_set_active_session switches the active id', async () => {
    await harness.callTool('redfin_register_session', {
      account_identity: 'a@example.com',
    });
    const b = parseToolResult<{ session: { session_id: string } }>(
      await harness.callTool('redfin_register_session', {
        account_identity: 'b@example.com',
      })
    );
    const r = await harness.callTool('redfin_set_active_session', {
      session_id: b.session.session_id,
    });
    const parsed = parseToolResult<{ active_session_id: string }>(r);
    expect(parsed.active_session_id).toBe(b.session.session_id);
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
