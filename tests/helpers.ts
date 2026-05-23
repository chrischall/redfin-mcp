import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export async function createTestHarness(
  registerFn: (server: McpServer) => void
): Promise<{
  client: Client;
  server: McpServer;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  listTools: () => Promise<{ name: string }[]>;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerFn(server);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    server,
    callTool: async (name, args) =>
      client.callTool({ name, arguments: args ?? {} }) as Promise<CallToolResult>,
    listTools: async () => {
      const result = await client.listTools();
      return result.tools.map((t) => ({ name: t.name }));
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * Parse the JSON body out of a tool's CallToolResult. Every redfin_*
 * tool returns a single text block of `JSON.stringify(data, null, 2)`.
 */
export function parseToolResult<T = unknown>(result: CallToolResult): T {
  const block = result.content[0] as { text: string };
  return JSON.parse(block.text) as T;
}
