// Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
// read off the served `tools/list` — what a host sees — never a hand-kept
// list of registrars' configs. The registrar list mirrors src/index.ts's
// `tools: [...]`, so a shared registrar (the realty-core calculators, the
// mcp-utils session trio) is checked exactly as a client sees it.
//
// Redfin answers no bare "what's new / due / on?": the saved homes are a
// snapshot (status and price now, no change dates), the saved searches are
// search definitions rather than their new matches, and every other read
// needs a place or home the person names. So no tool is canonical, and none
// declares `subject` or `when` — there is no listable set of the person's
// subjects to publish as an enum either.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

type Mint = {
  domain?: string;
  intent?: string;
  canonical?: boolean;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
};
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Mint };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  redfin_search_properties: 'lookup',
  redfin_sweep_area: 'lookup',
  redfin_get_by_address: 'lookup',
  redfin_get_property: 'lookup',
  redfin_get_property_photos: 'lookup',
  redfin_get_market_report: 'lookup',
  redfin_get_price_history: 'lookup',
  redfin_compare_properties: 'lookup',
  redfin_bulk_get: 'lookup',
  redfin_resolve_addresses: 'lookup',
  redfin_get_climate_risk: 'lookup',
  redfin_get_climate_risk_bulk: 'lookup',
  redfin_get_area_climate_baseline: 'lookup',
  redfin_get_comparable_rentals: 'lookup',
  redfin_get_saved_homes: 'lookup',
  redfin_get_saved_searches: 'lookup',
  redfin_calculate_mortgage: 'other',
  redfin_calculate_affordability: 'other',
  redfin_get_session_context: 'lookup',
  redfin_register_session: 'other',
  redfin_set_active_session: 'other',
};

const client = {
  fetchHtml: vi.fn(),
  fetchStingrayJson: vi.fn(),
} as unknown as RedfinClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let tools: Listed[] = [];
const hinted = () => tools.filter((t) => !t.name.endsWith('_healthcheck'));
const mintOf = (name: string) => tools.find((t) => t.name === name)?._meta?.mint;

beforeAll(async () => {
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
  // The raw client keeps _meta; a trimmed listing would not.
  tools = (await harness.client.listTools()).tools as Listed[];
});

afterAll(async () => {
  if (harness) await harness.close();
});

describe('_meta.mint on every served tool', () => {
  it('names every served tool but the healthcheck, so a new tool cannot skip the decision', () => {
    expect(hinted().map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
    expect(tools.map((t) => t.name)).toContain('redfin_healthcheck');
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain home and intent %s', (name, intent) => {
    const mint = mintOf(name);
    expect(mint, name).toBeDefined();
    expect(Object.keys(mint!).every((k) => KEYS.includes(k)), name).toBe(true);
    expect(DOMAINS).toContain(mint!.domain);
    expect(mint!.domain).toBe('home');
    expect(INTENTS).toContain(mint!.intent);
    expect(mint!.intent).toBe(intent);
  });

  it('keeps aliases to the words a person says: ≤ 8, lowercase, ≤ 40 chars, never a tool name', () => {
    for (const t of hinted()) {
      const aliases = t._meta!.mint!.aliases ?? [];
      expect(aliases.length, t.name).toBeLessThanOrEqual(8);
      for (const a of aliases) {
        expect(a, t.name).toBe(a.toLowerCase());
        expect(a.length, t.name).toBeLessThanOrEqual(40);
        expect(a, t.name).not.toMatch(/^redfin_/);
      }
    }
    expect(mintOf('redfin_search_properties')?.aliases).toContain('for sale');
    expect(mintOf('redfin_get_saved_homes')?.aliases).toContain('saved homes');
    expect(mintOf('redfin_get_climate_risk')?.aliases).toContain('flood risk');
    expect(mintOf('redfin_calculate_mortgage')?.aliases).toContain('mortgage');
  });

  it('names only arguments that exist when it declares subject or when', () => {
    for (const t of hinted()) {
      const m = t._meta!.mint!;
      const props = t.inputSchema.properties ?? {};
      if (m.subject) expect(props, t.name).toHaveProperty(m.subject);
      if (m.when) {
        expect(props, t.name).toHaveProperty(m.when.start);
        expect(props, t.name).toHaveProperty(m.when.end);
      }
    }
  });

  it('marks canonical only reads, only on what’s-new/due/on, at most one per intent, each with a brief view', () => {
    const canonical = hinted().filter((t) => t._meta!.mint!.canonical !== undefined);
    for (const t of canonical) {
      expect(t._meta!.mint!.canonical, t.name).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(CANONICAL_INTENTS, t.name).toContain(t._meta!.mint!.intent);
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
    }
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).length, intent).toBeLessThanOrEqual(1);
    }
  });

  it('declares no canonical read, subject or range: no Redfin read answers a bare what’s-new/due/on', () => {
    for (const t of hinted()) {
      const m = t._meta!.mint!;
      expect(m.canonical, t.name).toBeUndefined();
      expect(m.subject, t.name).toBeUndefined();
      expect(m.when, t.name).toBeUndefined();
    }
  });

  it('leaves the annotations the shared registrars set untouched', () => {
    expect(tools.find((t) => t.name === 'redfin_register_session')?.annotations?.destructiveHint).toBe(false);
    expect(tools.find((t) => t.name === 'redfin_calculate_mortgage')?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('withMintMeta', () => {
  it('adds _meta only to the named tools, keeps any _meta already set, and passes the rest of the server through', async () => {
    const { withMintMeta, homeMeta } = await import('../src/tools/hints.js');
    const h = await createTestHarness((server) => {
      const wrapped = withMintMeta(server, { named: homeMeta('lookup') });
      expect(wrapped.isConnected()).toBe(false);
      expect(wrapped.server).toBe(server.server);
      wrapped.registerTool('named', { description: 'n', _meta: { other: 1 } }, async () => ({ content: [] }));
      wrapped.registerTool('unnamed', { description: 'u' }, async () => ({ content: [] }));
    });
    const listed = (await h.client.listTools()).tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
    await h.close();
    expect(listed.find((t) => t.name === 'named')?._meta).toEqual({ other: 1, mint: { domain: 'home', intent: 'lookup' } });
    expect(listed.find((t) => t.name === 'unnamed')?._meta).toBeUndefined();
  });
});
