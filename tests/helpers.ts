// Test harness for redfin-mcp tools.
//
// `createTestHarness` + `parseToolResult` are the fleet-shared in-memory
// harness from `@chrischall/mcp-utils/test` — a connected McpServer +
// Client pair over InMemoryTransport that drives tools through the real
// client RPC path (schema validation, content envelopes, isError). They
// are re-exported here so every `tests/*.ts` keeps importing from
// `./helpers.js` while the byte-identical implementation lives upstream.
export { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
