/**
 * Small helpers for shaping tool responses that the MCP SDK expects.
 */

/**
 * Wrap any JSON-serializable value as a text-content MCP tool result.
 * Every `redfin_*` tool returns exactly one text block; this removes
 * boilerplate at the bottom of each handler.
 *
 * Re-exported from `@chrischall/mcp-utils` (the fleet-shared, byte-identical
 * `JSON.stringify(data, null, 2)` text wrapper) so every tool keeps importing
 * `textResult` from `../mcp.js` while the implementation lives upstream.
 */
export { textResult } from '@chrischall/mcp-utils';

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
