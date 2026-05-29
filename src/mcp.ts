/**
 * Small helpers for shaping tool responses that the MCP SDK expects.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Wrap any JSON-serializable value as a text-content MCP tool result.
 * Every `redfin_*` tool returns exactly one text block; this removes
 * boilerplate at the bottom of each handler.
 */
export function textResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Unwrap a Redfin `{ value: X }` envelope (many stingray fields are
 * boxed this way), or pass a raw value through unchanged. Nullish input
 * returns `undefined`. Shared by every formatter (search / properties /
 * saved / rentals) — previously a per-file copy.
 */
export function unwrapValue<T>(
  x: T | { value?: T } | undefined | null
): T | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'object' && 'value' in (x as object)) {
    return (x as { value?: T }).value;
  }
  return x as T;
}
