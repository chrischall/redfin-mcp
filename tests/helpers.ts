// Test harness for redfin-mcp tools.
//
// `createTestHarness` + `parseToolResult` are the fleet-shared in-memory
// harness from `@chrischall/mcp-utils/test` — a connected McpServer +
// Client pair over InMemoryTransport that drives tools through the real
// client RPC path (schema validation, content envelopes, isError). They
// are re-exported here so every `tests/*.ts` keeps importing from
// `./helpers.js` while the byte-identical implementation lives upstream.
export { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';

/**
 * A set of held-open fetches for the "work after the deadline" regression
 * tests (fleet-audit #956). `hold()` returns a promise that never settles
 * until `rejectAll(err)` fires; the test lets the batch deadline answer
 * `pending`, then releases the in-flight fetches and asserts no further
 * request was issued through the user's tab.
 */
export function createFetchGate() {
  const rejecters: Array<(e: unknown) => void> = [];
  return {
    hold<T>(): Promise<T> {
      return new Promise<T>((_resolve, reject) => {
        rejecters.push(reject);
      });
    },
    rejectAll(err: unknown): void {
      for (const r of rejecters.splice(0)) r(err);
    },
  };
}

/** Let released fetches + any follow-on runner work drain. */
export function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
