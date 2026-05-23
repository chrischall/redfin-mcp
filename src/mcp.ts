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
