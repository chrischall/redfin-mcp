import { describe, it, expect, vi, afterAll } from 'vitest';
import type { RedfinClient } from '../../src/client.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyProtocolError,
  FetchproxySessionNotReadyError,
  FetchproxyTimeoutError,
  classifyBridgeError,
} from '../../src/transport-fetchproxy.js';
import type { BridgeProbeResult, BridgeStatus } from '../../src/transport.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

// Full `@fetchproxy/server` 2.5.0 `BridgeHealth` shape — the shared
// healthcheck reads `session` + `lastExtensionMessageAt` off it.
const DEFAULT_STATUS: BridgeStatus = {
  role: 'host',
  port: 37149,
  host: '127.0.0.1',
  serverVersion: '0.0.0',
  fetchTimeoutMs: 30_000,
  bridgeReviveDelayMs: 2_000,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
  lastExtensionMessageAt: null,
  session: { state: 'linked', pairCode: null, extensionConnected: true },
  keepAlive: {
    enabled: true,
    intervalMs: 25_000,
    maxIdleMs: 0,
    lastPingAt: null,
    totalPings: 0,
    idleSinceMs: null,
  },
  swEviction: {
    lazyReviveAttempts: 0,
    lazyReviveSuccesses: 0,
    lastEvictionDetectedAt: null,
  },
};

function stubClient(args: {
  status?: Partial<BridgeStatus>;
  fetchHtml?: ReturnType<typeof vi.fn>;
}): RedfinClient {
  const status: BridgeStatus = { ...DEFAULT_STATUS, ...(args.status ?? {}) };
  const fetchHtml =
    args.fetchHtml ?? vi.fn().mockResolvedValue('User-agent: *');
  // The shared healthcheck drives `runProbe(fetchFn, path)` + `status()`
  // through the shim the registrar builds over the client. Reproduce the
  // 2.5.0 server contract here: run the probe fn, time it, classify any
  // throw via `classifyBridgeError`, and project the snake-cased `bridge`
  // block (including the session link) off the post-probe status.
  const runProbe = vi
    .fn()
    .mockImplementation(
      async (
        fetchFn: (path: string) => Promise<unknown>,
        probePath: string
      ): Promise<BridgeProbeResult> => {
        const bridge: BridgeProbeResult['bridge'] = {
          role: status.role,
          port: status.port,
          server_version: status.serverVersion,
          fetch_timeout_ms: status.fetchTimeoutMs,
          last_success_at: status.lastSuccessAt,
          last_failure_at: status.lastFailureAt,
          last_failure_reason: status.lastFailureReason,
          consecutive_failures: status.consecutiveFailures,
          session_state: status.session.state,
          pending_pair_code: status.session.pairCode,
          extension_connected: status.session.extensionConnected,
          last_extension_message_at: status.lastExtensionMessageAt,
        };
        const start = Date.now();
        try {
          await fetchFn(probePath);
          return { ok: true, elapsed_ms: Date.now() - start, bridge };
        } catch (e) {
          return {
            ok: false,
            elapsed_ms: Date.now() - start,
            bridge,
            error: {
              kind: classifyBridgeError(e),
              message: e instanceof Error ? e.message : String(e),
            },
          };
        }
      }
    );
  return {
    bridgeStatus: vi.fn().mockReturnValue(status),
    fetchHtml,
    runProbe,
  } as unknown as RedfinClient;
}

interface HealthcheckShape {
  ok: boolean;
  bridge: {
    role: string | null;
    port: number;
    server_version: string;
    fetch_timeout_ms: number;
    last_success_at: number | null;
    last_failure_at: number | null;
    last_failure_reason: string | null;
    consecutive_failures: number;
    last_extension_message_at: number | null;
    session_state: string;
    pending_pair_code: string | null;
    extension_connected: boolean;
  };
  probe: {
    url: string;
    elapsed_ms: number;
    status?: number;
    body_length?: number;
  };
  error?: {
    kind: string;
    message: string;
    bridge_hint?: string;
  };
  hint: string;
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

async function run(client: RedfinClient): Promise<HealthcheckShape> {
  harness = await createTestHarness((server) =>
    registerHealthcheckTools(server, client)
  );
  const r = await harness.callTool('redfin_healthcheck', {});
  // The healthcheck reports failure in the payload, never as a tool error.
  expect(r.isError).toBeFalsy();
  return parseToolResult<HealthcheckShape>(r);
}

describe('redfin_healthcheck tool', () => {
  it('returns ok=true with the extension link state when /robots.txt round-trips', async () => {
    const LAST_MSG_AT = Date.parse('2026-09-02T10:00:00Z');
    const client = stubClient({
      status: { lastExtensionMessageAt: LAST_MSG_AT },
      fetchHtml: vi.fn().mockResolvedValue('User-agent: *\nDisallow:\n'),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(true);
    expect(parsed.bridge.role).toBe('host');
    expect(parsed.bridge.port).toBe(37149);
    expect(parsed.bridge.session_state).toBe('linked');
    expect(parsed.bridge.pending_pair_code).toBeNull();
    expect(parsed.bridge.extension_connected).toBe(true);
    expect(parsed.bridge.last_extension_message_at).toBe(LAST_MSG_AT);
    expect(parsed.probe.url).toBe('https://www.redfin.com/robots.txt');
    expect(parsed.probe.status).toBe(200);
    expect(parsed.probe.body_length).toBeGreaterThan(0);
    expect(parsed.error).toBeUndefined();
    expect(parsed.hint).toMatch(/successfully/i);
  });

  it('probes through client.fetchHtml so Redfin sign-in guards run inside the round-trip', async () => {
    const fetchHtml = vi.fn().mockResolvedValue('User-agent: *');
    const client = stubClient({ fetchHtml });
    await run(client);
    expect(fetchHtml).toHaveBeenCalledWith('/robots.txt');
  });

  it('classifies a FetchproxyTimeoutError as kind=timeout with the extension-popup hint', async () => {
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
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('timeout');
    expect(parsed.bridge.role).toBe('peer');
    expect(parsed.hint).toMatch(/extension popup/i);
    expect(parsed.hint).toMatch(/redfin-mcp/);
    // Shared envelope: the role lives on the `bridge` block and the timing
    // on `probe.elapsed_ms` — no per-error duplicates.
    expect(parsed.probe.status).toBeUndefined();
    expect(typeof parsed.probe.elapsed_ms).toBe('number');
    expect(parsed.error).not.toHaveProperty('role_at_failure');
    expect(parsed.error).not.toHaveProperty('elapsed_ms_at_timeout');
  });

  it('bridge_down hint wins over the generic role=null hint when both apply', async () => {
    const client = stubClient({
      status: { role: null, port: 37149, serverVersion: '1.0.0' },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          originalError: 'Could not establish connection.',
          retryAttempted: true,
        })
      ),
    });
    const parsed = await run(client);
    expect(parsed.error?.kind).toBe('bridge_down');
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
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.bridge.role).toBeNull();
    expect(parsed.hint).toMatch(/never bound a role/);
    // The real configured port, not a hardcoded literal.
    expect(parsed.hint).toMatch(/port 37149/);
  });

  it('classifies a generic FetchproxyProtocolError as kind=protocol with the redfin.com-tab hint', async () => {
    const client = stubClient({
      fetchHtml: vi
        .fn()
        .mockRejectedValue(
          new FetchproxyProtocolError(
            'tab_fetch_failed: no signed-in redfin.com tab'
          )
        ),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('protocol');
    expect(parsed.hint).toMatch(/no redfin\.com tab is open/i);
  });

  it('classifies a FetchproxyBridgeDownError as kind=bridge_down with the server hint + SW-eviction copy', async () => {
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
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('bridge_down');
    expect(parsed.bridge.role).toBe('peer');
    // The server pre-builds an actionable recovery string on
    // FetchproxyBridgeDownError; the shared tool surfaces it verbatim.
    expect(parsed.error?.bridge_hint).toMatch(/.+/);
    expect(parsed.hint).toMatch(/service worker/i);
  });

  it('classifies a FetchproxySessionNotReadyError as kind=session_not_ready and names the pending pair code', async () => {
    const client = stubClient({
      status: {
        session: {
          state: 'pair_pending',
          pairCode: 'QX7K',
          extensionConnected: true,
        },
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxySessionNotReadyError({
          mcpId: 'redfin-mcp',
          pairCode: 'QX7K',
        })
      ),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('session_not_ready');
    expect(parsed.error?.bridge_hint).toMatch(/.+/);
    expect(parsed.bridge.session_state).toBe('pair_pending');
    expect(parsed.bridge.pending_pair_code).toBe('QX7K');
    expect(parsed.bridge.extension_connected).toBe(true);
    expect(parsed.hint).toMatch(/pair code QX7K/);
    expect(parsed.hint).toMatch(/redfin-mcp/);
  });

  it('session_not_ready with no extension attached says so instead of showing a bare timeout', async () => {
    const client = stubClient({
      status: {
        session: {
          state: 'extension_disconnected',
          pairCode: null,
          extensionConnected: false,
        },
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxySessionNotReadyError({
          mcpId: 'redfin-mcp',
          pairCode: null,
        })
      ),
    });
    const parsed = await run(client);
    expect(parsed.error?.kind).toBe('session_not_ready');
    expect(parsed.bridge.session_state).toBe('extension_disconnected');
    expect(parsed.bridge.extension_connected).toBe(false);
    expect(parsed.hint).toMatch(/No Transporter extension is attached/i);
    expect(parsed.hint).toMatch(/www\.redfin\.com tab/);
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
    const parsed = await run(client);
    expect(parsed.bridge.last_success_at).toBe(SUCCESS_AT);
    expect(parsed.bridge.last_failure_at).toBe(FAILURE_AT);
    expect(parsed.bridge.last_failure_reason).toMatch(/Could not establish/);
    expect(parsed.bridge.consecutive_failures).toBe(3);
  });

  it('classifies an unrelated error as kind=unknown', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(new Error('something else')),
    });
    const parsed = await run(client);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.kind).toBe('unknown');
    expect(parsed.hint).toMatch(/Unexpected error/);
  });
});
