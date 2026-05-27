import { describe, it, expect, vi, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyProtocolError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
import type { BridgeStatus } from '../../src/transport.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const DEFAULT_STATUS: BridgeStatus = {
  role: 'host',
  port: 37149,
  serverVersion: '0.0.0',
  fetchTimeoutMs: 30_000,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
};

function stubClient(args: {
  status?: Partial<BridgeStatus>;
  fetchHtml?: ReturnType<typeof vi.fn>;
}): RedfinClient {
  return {
    bridgeStatus: vi
      .fn()
      .mockReturnValue({ ...DEFAULT_STATUS, ...(args.status ?? {}) }),
    fetchHtml: args.fetchHtml ?? vi.fn().mockResolvedValue('User-agent: *'),
  } as unknown as RedfinClient;
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('redfin_healthcheck tool', () => {
  it('returns ok=true when /robots.txt round-trips through the bridge', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockResolvedValue('User-agent: *\nDisallow:\n'),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('redfin_healthcheck', {});
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      ok: boolean;
      bridge: { role: string; port: number };
      probe: { url: string; status: number; body_length: number };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(true);
    expect(parsed.bridge.role).toBe('host');
    expect(parsed.probe.url).toBe('https://www.redfin.com/robots.txt');
    expect(parsed.probe.status).toBe(200);
    expect(parsed.probe.body_length).toBeGreaterThan(0);
    expect(parsed.hint).toMatch(/successfully/i);
  });

  it('classifies a FetchproxyTimeoutError as kind=timeout with role-specific hint', async () => {
    const client = stubClient({
      status: {
        role: 'peer',
        port: 37200,
        serverVersion: '1.0.0',
        fetchTimeoutMs: 25,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.redfin.com/robots.txt',
          timeoutMs: 25,
          role: 'peer',
          port: 37200,
          elapsedMs: 27,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('redfin_healthcheck', {});
    expect(r.isError).toBeFalsy(); // healthcheck reports failure in payload, not as tool error
    const parsed = parseToolResult<{
      ok: boolean;
      bridge: { role: string };
      error: {
        kind: string;
        role_at_failure: string;
        elapsed_ms_at_timeout: number;
      };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('timeout');
    // 0.8.0+: role_at_failure is read straight off the typed error, not
    // from a post-throw bridgeStatus() snapshot. (Same value here, but
    // the source matters: errors carry the role at throw time.)
    expect(parsed.error.role_at_failure).toBe('peer');
    // 0.8.0+: timeouts surface the actual elapsed ms so users can tell
    // a hair-trigger timeout (timeout=25ms, elapsed≈26ms) from a real
    // hang (timeout=30000ms, elapsed≈30001ms).
    expect(parsed.error.elapsed_ms_at_timeout).toBe(27);
    expect(parsed.hint).toMatch(/extension popup/i);
  });

  it('bridge_down hint wins over the generic role=null hint when both apply', async () => {
    const client = stubClient({
      status: {
        role: null,
        port: 37149,
        serverVersion: '1.0.0',
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('redfin_healthcheck', {});
    const parsed = parseToolResult<{ error: { kind: string }; hint: string }>(r);
    expect(parsed.error.kind).toBe('bridge_down');
    expect(parsed.hint).toMatch(/service worker/i);
    expect(parsed.hint).not.toMatch(/never bound a role/);
  });

  it('hint when role is null points at startup failure, not extension issue', async () => {
    const client = stubClient({
      status: {
        role: null,
        port: 37149,
        serverVersion: '1.0.0',
        fetchTimeoutMs: 25,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.redfin.com/robots.txt',
          timeoutMs: 25,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('redfin_healthcheck', {});
    const parsed = parseToolResult<{
      ok: boolean;
      error: { role_at_failure: string | null };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.role_at_failure).toBeNull();
    expect(parsed.hint).toMatch(/never bound a role/);
  });

  it('classifies a generic FetchproxyProtocolError as kind=transport', async () => {
    const client = stubClient({
      fetchHtml: vi
        .fn()
        .mockRejectedValue(
          new FetchproxyProtocolError(
            'tab_fetch_failed: no signed-in redfin.com tab'
          )
        ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('redfin_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string }; hint: string }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('transport');
    expect(parsed.hint).toMatch(/no redfin\.com tab is open/i);
  });

  it('classifies a FetchproxyBridgeDownError as kind=bridge_down with SW-eviction hint', async () => {
    const client = stubClient({
      status: { role: 'peer', port: 37149, serverVersion: '0.5.0' },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError:
            'tab fetch failed: Error: Could not establish connection. Receiving end does not exist.',
          retryAttempted: true,
          role: 'peer',
          port: 37149,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('redfin_healthcheck', {});
    const parsed = parseToolResult<{
      ok: boolean;
      error: {
        kind: string;
        message: string;
        role_at_failure: string | null;
        bridge_hint: string;
      };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('bridge_down');
    // 0.8.0+: role read directly off the typed error (carried at throw time).
    expect(parsed.error.role_at_failure).toBe('peer');
    // 0.8.0+: the server pre-builds an actionable recovery string on
    // FetchproxyBridgeDownError. Surface it so the LLM can show the
    // user exactly what to do.
    expect(parsed.error.bridge_hint).toMatch(/.+/);
    expect(parsed.hint).toMatch(/service worker/i);
  });

  it('surfaces freshness counters (last_success_at, last_failure_at, consecutive_failures) on the bridge block', async () => {
    const SUCCESS_AT = Date.parse('2026-05-25T03:39:46Z');
    const FAILURE_AT = Date.parse('2026-05-25T03:40:00Z');
    const client = stubClient({
      status: {
        lastSuccessAt: SUCCESS_AT,
        lastFailureAt: FAILURE_AT,
        lastFailureReason: 'Could not establish connection.',
        consecutiveFailures: 3,
      },
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('redfin_healthcheck', {});
    const parsed = parseToolResult<{
      bridge: {
        last_success_at: number | null;
        last_failure_at: number | null;
        last_failure_reason: string | null;
        consecutive_failures: number;
      };
    }>(r);
    expect(parsed.bridge.last_success_at).toBe(SUCCESS_AT);
    expect(parsed.bridge.last_failure_at).toBe(FAILURE_AT);
    expect(parsed.bridge.last_failure_reason).toMatch(/Could not establish/);
    expect(parsed.bridge.consecutive_failures).toBe(3);
  });

  it('classifies an unrelated error as kind=other', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(new Error('something else')),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('redfin_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string } }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('other');
  });
});
