#!/usr/bin/env node
// redfin-mcp entrypoint.
//
// Boot sequence:
//   1. Construct a FetchproxyTransport listening on 127.0.0.1:37149.
//      The shared fetchproxy Chrome/Safari extension — installed
//      separately, not in this repo — connects here.
//      See https://github.com/chrischall/fetchproxy.
//   2. RedfinClient.start() — brings the transport up.
//   3. Register tool handlers against the MCP server.
//   4. Connect the MCP server to stdio for the host client.
//
// The transport outlives the MCP session. On SIGINT/SIGTERM we close it
// so ports/connections don't leak between client restarts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RedfinClient } from './client.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { registerSearchTools } from './tools/search.js';
import { registerPropertyTools } from './tools/properties.js';
import { registerSavedTools } from './tools/saved.js';
import { registerMarketTools } from './tools/market.js';
import { registerMortgageTools } from './tools/mortgage.js';
import { registerHistoryTools } from './tools/history.js';
import { registerCompareTools } from './tools/compare.js';
import { registerClimateTools } from './tools/climate.js';
import { registerRentalsTools } from './tools/rentals.js';
import { registerAffordabilityTools } from './tools/affordability.js';
import { registerPhotosTools } from './tools/photos.js';

const VERSION = '0.4.3'; // x-release-please-version

const port = process.env.REDFIN_WS_PORT
  ? Number(process.env.REDFIN_WS_PORT)
  : undefined;

const transport = new FetchproxyTransport({ port, version: VERSION });

const client = new RedfinClient({ transport });
await client.start();

const server = new McpServer({ name: 'redfin-mcp', version: VERSION });

registerSearchTools(server, client);
registerPropertyTools(server, client);
registerSavedTools(server, client);
registerMarketTools(server, client);
registerMortgageTools(server);
registerHistoryTools(server, client);
registerCompareTools(server, client);
registerClimateTools(server, client);
registerRentalsTools(server, client);
registerAffordabilityTools(server);
registerPhotosTools(server, client);

console.error(
  `[redfin-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${port ?? 37149}. ` +
    'Install the fetchproxy extension (see https://github.com/chrischall/fetchproxy) ' +
    'and sign into redfin.com. This project was developed and is maintained by AI (Claude). ' +
    'Use at your own discretion.'
);

const shutdown = async () => {
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const stdio = new StdioServerTransport();
await server.connect(stdio);
