---
name: redfin
description: Look up real-estate listings, property details, market reports, and your saved homes/searches on Redfin via MCP. Triggers on phrases like "find homes on redfin in", "redfin property details for", "show my saved redfin homes", "what's my saved redfin search seeing", "what does redfin say about", "redfin market report for", or any request involving Redfin properties, prices, or your saved Redfin activity. Requires redfin-mcp installed and the fetchproxy extension active (see Setup below).
---

# redfin-mcp

MCP server for Redfin — natural-language access to listings, property records, market reports, and your saved homes/searches. Routes through your signed-in redfin.com tab via the fetchproxy browser extension, so AWS WAF / DataDome see a real browser session instead of a Node process.

- **npm:** [npmjs.com/package/redfin-mcp](https://www.npmjs.com/package/redfin-mcp)
- **Source:** [github.com/chrischall/redfin-mcp](https://github.com/chrischall/redfin-mcp)

> ⚠️ Redfin does not publish a public consumer API. This server uses the same private `/stingray/...` endpoints the redfin.com web app calls, dispatched through your own signed-in browser tab via the fetchproxy extension. Use at your own discretion.

## Setup

### 1. Install redfin-mcp

`.mcp.json` (project) or `~/.claude/mcp.json` (global):

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

### 2. Install the fetchproxy extension (one-time, shared across all fetchproxy-based MCPs)

```bash
git clone https://github.com/chrischall/fetchproxy
cd fetchproxy
npm ci
npm --workspace=@fetchproxy/extension-chrome run build
```

Then in Chrome: `chrome://extensions` → Developer mode → Load unpacked → pick `packages/extension-chrome/dist/`.

### 3. Open redfin.com and sign in.

That's it. No API keys, no env vars.

## Tools

### Public data

- **`redfin_search_properties`** — Search by location + filters (price, beds/baths min, home type). Resolves the location via Redfin's autocomplete then queries the `/stingray/api/gis` endpoint. Returns matching listings with price, beds/baths, sqft, year built, address, and the Redfin home URL.
- **`redfin_get_property(view?)`** — Full property record by `url` (Redfin homedetails URL or path), `property_id` alone (resolved internally by following Redfin's `/home/<id>` redirect to the canonical slug, then `initialInfo`), or `property_id` + `listing_id` (fastest — skips resolution). Two-round-trip API: `initialInfo` resolves the URL to IDs, then `aboveTheFold` fetches the data. Returns address, beds/baths, sqft, year built, price, status, days on market, primary photo.
- **`redfin_get_market_report`** — Median sale/list prices, price per sqft, days on market, year-over-year change, homes sold/on market for a Redfin region. Provide either `location` (free-text) or `region_id` + `region_type`. All metrics returned as formatted strings (e.g. `"$870K"`, `"+2.4%"`).
- **`redfin_calculate_mortgage`** — Local PITI calculator. No network call. Provide home price, interest rate, optional down payment / taxes / insurance / HOA / PMI; returns a full monthly breakdown.

### Signed-in user data (the unique value vs. paid scrapers)

- **`redfin_get_saved_homes(view?)`** — Your favorited homes, flattened across all collections. Returns address, price, beds/baths, status.
- **`redfin_get_saved_searches(view?)`** — Your saved searches with region URLs and display text.

## Response shape (`view`)

Six tools take `view: "compact" | "full"`, and **`compact` is the default** —
the slim rung arrives without being asked for, because an efficiency a caller
has to know about and request is one that usually is not requested:

`redfin_get_property`, `redfin_get_saved_homes`, `redfin_get_saved_searches`,
`redfin_bulk_get`, `redfin_compare_properties`, `redfin_resolve_addresses`.

**Compact strips image URLs, and claims no field projection.** This server
hands Redfin's payloads back close to verbatim and holds no captured fixture or
documented field list for them, so nothing here can honestly say which of
Redfin's fields matter and which are noise. Stripping media needs no such
knowledge and is SUBTRACTIVE, so it cannot lose a field nobody knew about —
which is what an invented field list would risk, returning a record with holes
in it that still reads like a verified answer. Do not expect a named field set
from compact; expect the same record minus picture URLs.

Two photo fields are decided by name rather than left to the blind rule, and
the distinction is worth knowing because it looks arbitrary until you see why:

- **`image_url` and `thumbnail_url` are KEPT.** On a saved-home card this
  server CONSTRUCTS them from `mlsId` + `dataSourceId` — they are derived with
  knowledge of Redfin's URL scheme, not incidental decoration — and the
  `photo_count` beside them is your cue that `redfin_get_property_photos` has
  more.
- **`primary_photo_url` is DROPPED.** `redfin_get_property` reads it straight
  off Redfin's `atf.mediaBrowserInfo` — an upstream CDN URL carried through
  verbatim, which is exactly the shape media stripping exists to remove. Naming
  it is what makes the removal deterministic: the blind rule catches it today
  only because Redfin's URLs happen to end in `.jpg`, so a signed or
  extension-less URL would silently start surviving compact.

`view: "full"` returns Redfin's payload untouched. There is **no `raw` rung**:
`full` already IS the untouched payload, so a third value could only alias it.

The other fifteen tools take no `view`, and not for one blanket reason:

- **`redfin_search_properties`, `redfin_get_market_report`,
  `redfin_get_price_history`, `redfin_get_comparable_rentals`,
  `redfin_get_climate_risk` (and its bulk/baseline siblings), and
  `redfin_get_by_address`** each build their answer through a hand-written
  formatter — `formatHome`, `formatMetric`, `formatPriceEvent`,
  `formatRentalComp`, `formatClimate`. The response is already field-picked
  with knowledge of the payload and carries no pass-through CDN URL, so a blind
  rung run over it could only overrule a grounded choice with an un-grounded
  one.
- **`redfin_get_property_photos`** is the documented way media stripping can be
  misused: its PRODUCT is the `photoUrls` bundle. Compacting here would not
  shrink the answer, it would empty it.
- **`redfin_calculate_mortgage` and `redfin_calculate_affordability`** make no
  network call at all. There is no upstream payload — the response is
  arithmetic this server did.
- **`redfin_register_session`, `redfin_set_active_session` and
  `redfin_get_session_context`** are session bookkeeping: an id and a status.
- **`redfin_healthcheck`** answers reachability and auth.

## Trigger examples

- "Find me 2-bedroom condos under $1.5M in Brooklyn on Redfin" → `redfin_search_properties`
- "What does Redfin say about 42 Monroe St in Brooklyn?" → `redfin_get_property`
- "Pull up my favorited homes on Redfin" → `redfin_get_saved_homes`
- "What's new on my saved Redfin searches?" → `redfin_get_saved_searches`
- "Brooklyn housing market trends on Redfin" → `redfin_get_market_report`
- "Monthly payment on a $500k home, 20% down, 6.5% rate" → `redfin_calculate_mortgage`

## Gotchas

- **Sign-in required for saved-* tools.** If the user isn't signed into redfin.com in the bridged Chrome tab, those tools fail with `SessionNotAuthenticatedError`. Public tools work either way.
- **AWS WAF challenge.** Redfin occasionally serves a WAF challenge to fresh sessions. Solving it in the Chrome tab once unblocks subsequent fetches.
- **No write surface yet.** All tools are read-only. Saving a home / search / contact form are not implemented in v0.1.
- **`for_rent` / `sold` listing statuses** map to entirely different Redfin URL paths (`/apartments-for-rent/...`, `/recently-sold`). v0.1 of `redfin_search_properties` supports `for_sale` only.
- **No equivalent to Zillow's Zestimate history tool.** Redfin's Redfin Estimate is exposed as a current scalar inside `redfin_get_property`; there's no historical-series endpoint yet.
