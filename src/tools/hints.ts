import type { McpServer } from '@modelcontextprotocol/server';

/**
 * `_meta.mint` hints (the mcp-host context-groups contract): which canonical
 * group a tool belongs to, what kind of ask it answers, and everyday words
 * its name and description lack. Inert data to any other client.
 *
 * Redfin answers no bare "what's new / due / on?": the saved homes are a
 * snapshot (status and price now, no change dates), the saved searches are
 * search definitions rather than their new matches, and every other read
 * needs a place or home the person names. So no tool is canonical, and none
 * declares `subject` or `when`.
 */
type MintIntent = 'lookup' | 'other';

type MintHint = {
  domain: 'home';
  intent: MintIntent;
  aliases?: string[];
};

/** A type alias, not an interface, so it fits the SDK's `_meta: Record<string, unknown>`. */
export type MintMeta = {
  mint: MintHint;
};

/** A home-group hint with the given intent (and optional aliases). */
export function homeMeta(intent: MintIntent, aliases?: string[]): MintMeta {
  return { mint: aliases ? { domain: 'home', intent, aliases } : { domain: 'home', intent } };
}

/** What people say when they are house-hunting. Lowercase, ≤ 8, each ≤ 40 chars. */
export const FOR_SALE_ALIASES = ['for sale', 'house hunting', 'homes for sale', 'listings', 'open house', 'condo', 'townhouse'];

/** What people say about one home they have in mind. */
export const HOME_ALIASES = ['that house', 'listing details', 'home details', 'how big is it', 'what is it listed at'];

/** What people say about a home's past prices. */
export const PRICE_HISTORY_ALIASES = ['price history', 'price drop', 'price cut', 'last sold', 'what it sold for', 'sold price'];

/** What people say about an area's market. */
export const MARKET_ALIASES = ['housing market', 'home prices', 'market trends', 'median price', 'days on market'];

/** What people say about climate exposure. */
export const CLIMATE_ALIASES = ['flood risk', 'fire risk', 'heat risk', 'climate risk', 'flood zone'];

/** What people say about renting a home out. */
export const RENTAL_ALIASES = ['rent estimate', 'what would it rent for', 'rental comps', 'comparable rents'];

/** What people call their favorited homes. */
export const SAVED_HOMES_ALIASES = ['saved homes', 'favorites', 'favorite homes', 'homes i saved', 'my redfin'];

/** What people call their saved searches. */
export const SAVED_SEARCHES_ALIASES = ['saved searches', 'my searches', 'home alerts', 'search alerts'];

/** What people say about a home loan. */
export const MORTGAGE_ALIASES = ['mortgage', 'monthly payment', 'home loan', 'piti'];

/** What people say about their buying budget. */
export const AFFORDABILITY_ALIASES = ['how much house', 'can i afford', 'afford', 'home budget'];

/**
 * A view of `server` whose `registerTool` adds the named tools' `_meta` and
 * passes everything else through untouched — for the shared registrars
 * (realty-core's calculators, mcp-utils' session trio), which take no
 * `_meta` option of their own.
 */
export function withMintMeta(server: McpServer, metaByName: Record<string, MintMeta>): McpServer {
  const registerTool = ((name: string, config: Record<string, unknown>, cb: unknown) =>
    (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(
      name,
      metaByName[name] ? { ...config, _meta: { ...(config._meta as object | undefined), ...metaByName[name] } } : config,
      cb
    )) as McpServer['registerTool'];
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') return registerTool;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
