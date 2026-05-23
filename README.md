# redfin-mcp

Redfin real-estate access as an MCP server for Claude — search listings, fetch property details, market reports, and your saved homes/searches via natural language.

> ⚠️ Redfin does not publish a public consumer API. This server uses the same private `/stingray/...` endpoints the redfin.com web app uses, routed through your own signed-in browser tab via the [fetchproxy](https://github.com/chrischall/fetchproxy) extension. AWS WAF + DataDome see a real browser session, not a Node process — but you should still treat this as informal use of Redfin's website. Use at your own discretion.

## Tools

| Tool | Purpose | Auth-scoped |
| --- | --- | :---: |
| `redfin_search_properties` | Search listings by location, price band, beds/baths, home type. Resolves free-text via Redfin's autocomplete then queries the `gis` API. | |
| `redfin_get_property` | Full record for a property by URL or `property_id`+`listing_id`. Address, beds/baths, sqft, year built, price, status, days on market, primary photo. | |
| `redfin_get_market_report` | Median sale/list prices, ZHVI YoY, average days on market, inventory for a region. | |
| `redfin_get_saved_homes` | Your favorited homes — flattened across all collections. | ✓ |
| `redfin_get_saved_searches` | Your saved searches with region URLs and display text. | ✓ |
| `redfin_calculate_mortgage` | Local PITI calculator — principal+interest, taxes, insurance, HOA, PMI (no network). | |

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

The MCP server runs in Node, but every HTTP call to redfin.com is dispatched into your live browser tab through the fetchproxy extension. AWS WAF / DataDome see a real browser making a real request from a real session — TLS fingerprint, cookies, JS execution all match the page that's already on screen. No headless browser, no impersonation, no proxy farm.

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
