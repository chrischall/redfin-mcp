// Invariant: manifest.json (shipped in the .mcpb) lists exactly the tools the
// server registers. It drifted to 7 of 22 (fleet-audit #673); this keeps the
// two in lockstep. The registrar list mirrors src/index.ts's `tools: [...]`.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionRegistry } from '@chrischall/mcp-utils/session';
import type { RedfinClient } from '../src/client.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerPropertyTools } from '../src/tools/properties.js';
import { registerSavedTools } from '../src/tools/saved.js';
import { registerMarketTools } from '../src/tools/market.js';
import { registerMortgageTools } from '../src/tools/mortgage.js';
import { registerHistoryTools } from '../src/tools/history.js';
import { registerCompareTools } from '../src/tools/compare.js';
import { registerClimateTools } from '../src/tools/climate.js';
import { registerRentalsTools } from '../src/tools/rentals.js';
import { registerAffordabilityTools } from '../src/tools/affordability.js';
import { registerPhotosTools } from '../src/tools/photos.js';
import { registerGetByAddressTools } from '../src/tools/get-by-address.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerBulkGetTools } from '../src/tools/bulk-get.js';
import { registerResolveAddressesTools } from '../src/tools/resolve-addresses.js';
import { registerSessionTools } from '../src/tools/sessions.js';
import { createTestHarness } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  tools: Array<{ name: string; description: string }>;
};

const client = {
  fetchHtml: vi.fn(),
  fetchStingrayJson: vi.fn(),
} as unknown as RedfinClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('manifest.json tool list', () => {
  it('names exactly the registered tools, each with a description', async () => {
    harness = await createTestHarness((server) => {
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
      registerGetByAddressTools(server, client);
      registerHealthcheckTools(server, client);
      registerBulkGetTools(server, client);
      registerResolveAddressesTools(server, client);
      registerSessionTools(server, createSessionRegistry());
    });
    const registered = (await harness.listTools()).map((t) => t.name).sort();
    const listed = manifest.tools.map((t) => t.name).sort();
    expect(listed).toEqual(registered);
    for (const t of manifest.tools) expect(t.description.length).toBeGreaterThan(10);
  });
});
