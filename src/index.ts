#!/usr/bin/env node
// redfin-mcp entrypoint.
//
// Boot sequence:
//   1. Construct a FetchproxyTransport listening on 127.0.0.1:37149.
//      The shared fetchproxy Chrome/Safari extension — installed
//      separately, not in this repo — connects here.
//      See https://github.com/chrischall/fetchproxy.
//   2. RedfinClient.start() — brings the transport up. This runs BEFORE
//      runMcp connects stdio, preserving the deferred-config-error
//      pattern: a bridge that can't come up surfaces here, before the
//      host's first tool call, rather than wedging the JSON-RPC channel.
//   3. runMcp registers tool handlers, prints the stderr banner, wires
//      SIGINT/SIGTERM → client.close(), and connects the MCP server to
//      stdio for the host client.
//
// The transport outlives the MCP session. On SIGINT/SIGTERM the
// `shutdown.onSignal` hook closes it so ports/connections don't leak
// between client restarts.
import { runMcp, readEnvVar } from '@chrischall/mcp-utils';
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
import { registerGetByAddressTools } from './tools/get-by-address.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerBulkGetTools } from './tools/bulk-get.js';
import { registerResolveAddressesTools } from './tools/resolve-addresses.js';
import { registerSessionTools } from './tools/sessions.js';

const VERSION = '0.9.1'; // x-release-please-version

const portRaw = readEnvVar('REDFIN_WS_PORT');
const port = portRaw ? Number(portRaw) : undefined;

const transport = new FetchproxyTransport({ port, version: VERSION });

const client = new RedfinClient({ transport });
// Bring the bridge up BEFORE runMcp connects stdio (deferred-config-error
// pattern — a failure here surfaces before any tool call).
await client.start();

await runMcp({
  name: 'redfin-mcp',
  version: VERSION,
  deps: client,
  tools: [
    (server) => registerSearchTools(server, client),
    (server) => registerPropertyTools(server, client),
    (server) => registerSavedTools(server, client),
    (server) => registerMarketTools(server, client),
    (server) => registerMortgageTools(server),
    (server) => registerHistoryTools(server, client),
    (server) => registerCompareTools(server, client),
    (server) => registerClimateTools(server, client),
    (server) => registerRentalsTools(server, client),
    (server) => registerAffordabilityTools(server),
    (server) => registerPhotosTools(server, client),
    (server) => registerGetByAddressTools(server, client),
    (server) => registerHealthcheckTools(server, client),
    (server) => registerBulkGetTools(server, client),
    (server) => registerResolveAddressesTools(server, client),
    (server) => registerSessionTools(server),
  ],
  banner:
    `[redfin-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${port ?? 37149}. ` +
    'Install the fetchproxy extension (see https://github.com/chrischall/fetchproxy) ' +
    'and sign into redfin.com. This project was developed and is maintained by AI (Claude). ' +
    'Use at your own discretion.',
  shutdown: { onSignal: () => client.close() },
});
