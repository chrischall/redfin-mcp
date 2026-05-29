# redfin-mcp

Redfin real-estate access as an MCP server for Claude — search listings, fetch property details, market reports, and your saved homes/searches via natural language.

> ⚠️ Redfin does not publish a public consumer API. This server uses the same private `/stingray/...` endpoints the redfin.com web app uses, routed through your own signed-in browser tab via the [fetchproxy](https://github.com/chrischall/fetchproxy) extension. Every request acts on behalf of your existing session — your cookies, your TLS, your JS context — exactly as if you'd clicked it in the browser yourself. Treat this as informal use of Redfin's website. Use at your own discretion.

## Tools

| Tool | Purpose | Auth-scoped |
| --- | --- | :---: |
| `redfin_search_properties` | Search listings by location, price band, beds/baths, home type. Resolves free-text via Redfin's autocomplete then queries the `gis` API. | |
| `redfin_get_property` | Full record for a property by URL, `property_id` alone, or `property_id`+`listing_id`. Address, beds/baths, sqft, year built, price, status, days on market, primary photo. | |
| `redfin_get_property_photos` | Full photo gallery for a property — every CDN image at fullscreen/large/medium sizes plus thumbnails and captions. | |
| `redfin_get_market_report` | Median sale/list prices, ZHVI YoY, average days on market, inventory for a region. | |
| `redfin_get_price_history` | Listing-history and tax-roll events for a property — Listed/Sold/Pending entries plus annual assessed values and taxes paid. | |
| `redfin_compare_properties` | Side-by-side comparison of up to 12 properties: address, price, beds/baths, sqft, $/sqft, year built, status, days on market. Aligned summary table. | |
| `redfin_get_climate_risk` | First Street Foundation flood / fire / heat risk factors for a property — FEMA zones, 30-year flood-chance series, insurance bands, cumulative-heat projections. | |
| `redfin_get_comparable_rentals` | Comparable rentals near a property — monthly rent, beds/baths, sqft, distance. Used for rent estimation. | |
| `redfin_calculate_affordability` | Local affordability calculator — back-of-envelope max purchase price from income + DTI + rates (no network). | |
| `redfin_get_saved_homes` | Your favorited homes — flattened across all collections, with primary photo URLs constructed from each home's CDN handles. | ✓ |
| `redfin_get_saved_searches` | Your saved searches with region URLs and display text. | ✓ |
| `redfin_calculate_mortgage` | Local PITI calculator — principal+interest, taxes, insurance, HOA, PMI (no network). | |
| `redfin_get_by_address` | Resolve a free-text address to its Redfin canonical URL + home_id. Degrades to `resolved: false` when no listing matches. One autocomplete round-trip. | |
| `redfin_healthcheck` | End-to-end bridge check — round-trips `/robots.txt` and reports which hop failed (bridge down vs. extension not connected vs. Redfin-side issue). Call when other tools time out. | |

## Acknowledgement of Terms

By using this MCP server, you acknowledge and agree to the following:

**1. This server accesses your own Redfin session.** Every request is dispatched through your own browser tab via the fetchproxy extension — your cookies, your TLS, your session. It does not — and cannot — access anyone else's account.

**2. [Redfin's Terms of Use](https://www.redfin.com/about/terms-of-use) govern your use of this server**, just as they govern your direct use of redfin.com. The clauses most relevant here:

> You may not automatedly crawl or query the Services for any purpose or by any means (including, without limitation, screen and database scraping, spiders, robots, crawlers and any other automated activity with the purpose of obtaining information from the Services) unless you have received prior express written permission from the applicable Redfin Company.

And: *"You agree to keep your password confidential, not use others' accounts, nor permit others to use your account."*

You are agreeing to those terms — read by the maintainer 2026-05-23 — every time you invoke a tool in this server. Redfin's terms prohibit automated crawling without written permission, and IDX listing data is licensed for personal, non-commercial use only.

**3. Personal, non-commercial use only.** This project is not affiliated with, endorsed by, sponsored by, or in partnership with Redfin Corporation. It is a personal automation tool that calls the same `/stingray/...` endpoints redfin.com calls when you click around. Do not use it to bulk-extract listings, redistribute IDX data, train AI models, populate a competing real-estate product, or for any commercial purpose.

**4. Stability is not guaranteed.** This server reads private internal endpoints (`/stingray/api/gis`, `/stingray/api/home/details/*`, `/stingray/api/region/.../offer-insights`, `/myredfin/*`) that Redfin may change without notice. It may break. It may stop working. That's by design — the surface is not theirs to maintain on our behalf.

**5. You accept full responsibility** for any consequences of using this server in connection with your Redfin access — rate limiting, account suspension, IP blocks, AWS WAF challenges, or any enforcement action Redfin takes. If Redfin objects to your use, stop using this server.

This section is the maintainer's good-faith summary of the terms — it is not legal advice and does not modify or supersede Redfin's actual ToU.

## Install

### Option A — npx (after first publish)

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "redfin": {
      "command": "npx",
      "args": ["-y", "redfin-mcp"]
    }
  }
}
```

### Option B — from source

```bash
git clone https://github.com/chrischall/redfin-mcp
cd redfin-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "redfin": {
      "command": "node",
      "args": ["/path/to/redfin-mcp/dist/bundle.js"]
    }
  }
}
```

### One-time browser setup

redfin-mcp talks to your browser through the [fetchproxy](https://github.com/chrischall/fetchproxy) extension, which is shared across every fetchproxy-based MCP (zillow-mcp, opentable-mcp, resy-mcp, …). Install it once:

```bash
git clone https://github.com/chrischall/fetchproxy
cd fetchproxy
npm ci
npm --workspace=@fetchproxy/extension-chrome run build
```

Then in Chrome: `chrome://extensions` → toggle Developer mode → Load unpacked → pick `packages/extension-chrome/dist/`.

Open redfin.com and sign in. That's all the auth this server needs.

## How it works

```
┌────────────────┐  stdio   ┌──────────────────┐   WS   ┌──────────────────┐    fetch()    ┌─────────────┐
│ MCP client     │◀────────▶│  dist/bundle.js  │◀──────▶│  fetchproxy      │◀────────────▶│ redfin.com  │
│ (Claude, etc.) │          │  (Redfin MCP)    │ :37149 │  extension       │   (real TLS, │ (your tab)  │
└────────────────┘          └──────────────────┘        │  (separate)      │   cookies)    └─────────────┘
```

The MCP server runs in Node, but every HTTP call to redfin.com is dispatched into your live browser tab through the fetchproxy extension. Each request rides your existing session — TLS fingerprint, cookies, and JS execution context all match the page that's already on screen. No headless browser stand-in, no separate identity, no third-party proxy: just your real browser, acting on its own behalf, with the MCP server picking what to ask for.

Redfin's `/stingray/...` JSON endpoints respond with a `{}&&` anti-CSRF prefix before the JSON body; the client strips it transparently.

## Commands

```bash
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage
npm run build          # tsc --noEmit + esbuild bundle → dist/bundle.js
npm run dev            # node dist/bundle.js (after build)
```

## License

MIT
