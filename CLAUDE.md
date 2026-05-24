# CLAUDE.md — redfin-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.1.0: Redfin MCP server. Default and only transport: localhost WebSocket via [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) — the companion browser extension is installed separately rather than embedded. Every HTTP call to redfin.com is dispatched through the user's signed-in Chrome tab, so AWS WAF / DataDome see a real browser fetch, not us directly.

This is a "Pattern A" fetchproxy MCP (every call through fetchproxy), not "Pattern B" (one bootstrap call then direct fetch). Redfin's bot wall checks each request.

## Tool surface

| Tool | File | Endpoint(s) | Kind |
| --- | --- | --- | --- |
| `redfin_search_properties` | `tools/search.ts` | (a) `GET /stingray/do/location-autocomplete?location=…` → region<br>(b) `GET /stingray/api/gis?region_id=…&region_type=…&…` | read |
| `redfin_get_property` | `tools/properties.ts` | (a) `GET /stingray/api/home/details/initialInfo?path=…` → propertyId+listingId<br>(b) `GET /stingray/api/home/details/aboveTheFold?propertyId=…&listingId=…` | read |
| `redfin_get_property_photos` | `tools/photos.ts` | (a) optional `initialInfo` to resolve IDs<br>(b) `GET /stingray/api/home/details/aboveTheFold?…` (mediaBrowserInfo.photos[]) | read |
| `redfin_get_market_report` | `tools/market.ts` | `GET /stingray/api/region/<region_type>/<region_id>/<property_type>/offer-insights` | read |
| `redfin_get_price_history` | `tools/history.ts` | `GET /stingray/api/home/details/belowTheFold?propertyId=…&listingId=…` | read |
| `redfin_compare_properties` | `tools/compare.ts` | `GET /stingray/api/home/details/aboveTheFold?…` ×N (concurrent) | read |
| `redfin_get_climate_risk` | `tools/climate.ts` | `GET /<homedetails-path>` HTML — extract `floodData`/`fireData`/`heatData` blocks | read |
| `redfin_get_comparable_rentals` | `tools/rentals.ts` | `GET /stingray/api/home/comparable-rentals?propertyId=…&rentEstimateLow=…&rentEstimateHigh=…` | read |
| `redfin_get_saved_homes` | `tools/saved.ts` | (a) `GET /myredfin/favorites` HTML → regex propertyIds<br>(b) `GET /stingray/do/api/v3/favorites/homecards?b=<csv-ids>` — image URLs constructed locally from mlsId+dataSourceId | read (auth) |
| `redfin_get_saved_searches` | `tools/saved.ts` | `GET /myredfin/saved-searches` HTML → regex region URLs | read (auth) |
| `redfin_calculate_mortgage` | `tools/mortgage.ts` | (local; no network) | read |
| `redfin_calculate_affordability` | `tools/affordability.ts` | (local; no network) | read |

All `/stingray/...` JSON responses begin with a `{}&&` anti-CSRF prefix; `RedfinClient.fetchStingrayJson` strips it. The two HTML-scraped tools (saved homes, saved searches) use regex extraction since Redfin's user-facing pages are React Server Components — there's no embedded `__NEXT_DATA__` blob like Zillow has.

## Architecture

```
src/
  index.ts              # entry — builds FetchproxyTransport, RedfinClient,
                        #   registers tool groups, connects stdio transport
  transport.ts          # RedfinTransport interface
  transport-fetchproxy.ts # adapter over @fetchproxy/server's FetchproxyServer
  client.ts             # RedfinClient.fetchHtml / fetchJson / fetchStingrayJson
                        #   + sign-in detection (WAF challenge / /login redirect)
                        #   + stripStingrayPrefix helper
  autocomplete.ts       # resolveRegion: free-text → region_id+region_type via
                        #   /stingray/do/location-autocomplete
  url.ts                # urlToPath — reduce a Redfin URL or bare path
                        #   to its path+search portion
  mcp.ts                # textResult() result-wrapper
  tools/
    search.ts           # redfin_search_properties (buildGisPath + formatHome)
    properties.ts       # redfin_get_property (initialInfo + aboveTheFold)
    market.ts           # redfin_get_market_report (offer-insights endpoint)
    saved.ts            # redfin_get_saved_homes + redfin_get_saved_searches
                        #   (HTML extract → optional homecards API)
    mortgage.ts         # redfin_calculate_mortgage (local PITI)

tests/                  # 1:1 mirror of src/, plus tests/helpers.ts harness.
                        #   All tests mock RedfinClient.{fetchHtml,fetchStingrayJson}.
```

Each `tools/*.ts` file exports `registerXxxTools(server, client)` (or `(server)` for the local-only mortgage tool); `src/index.ts` calls all of them.

## Commands

```bash
npm run build          # tsc --noEmit + esbuild bundle → dist/bundle.js
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage  # v8 coverage, no thresholds
npx tsc --noEmit       # typecheck only
node dist/bundle.js    # launch the MCP server over stdio (also opens WS)
```

## Environment

No env vars required. Auth lives in the user's signed-in redfin.com tab via the fetchproxy extension.

Optional:

```
REDFIN_WS_PORT=37149   # override the fetchproxy WebSocket port
```

## Conventions

- All tools prefixed `redfin_*`.
- Tool return shape: `textResult(data)` from `src/mcp.ts` → `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`. Don't hand-roll the wrapper.
- Tool annotations: every tool sets `title`, `readOnlyHint: true`, `idempotentHint: true`, and `openWorldHint`. The last is `true` for network-bound tools and `false` for `redfin_calculate_mortgage` (pure local computation).
- Path-only inputs to `RedfinClient`: pass `/some/path?with=query`, never a full URL. `FetchproxyTransport` prepends `https://www.redfin.com`. When a tool takes a `url` arg from the user, reduce it via `urlToPath` from `src/url.ts`.
- Always use `client.fetchStingrayJson(...)` for `/stingray/...` endpoints — never `fetchJson`. Stingray responses carry a `{}&&` anti-CSRF prefix that has to be stripped, AND a `{resultCode, errorMessage, payload}` envelope that needs to be checked. The helper handles both.
- Write a failing test before implementation (TDD).
- ESM + NodeNext: imports use `.js` extensions even for `.ts` source.
- stdio transport: log warnings/banners to **stderr** only — stdout is reserved for JSON-RPC.

## Redfin quirks

- **No `__NEXT_DATA__`.** Redfin is a React Server Components app; the homepage and user pages do NOT embed a Next.js hydration blob. Tools that need data either (a) call a `/stingray/...` JSON API (search, property, market) or (b) regex-extract IDs from the page HTML and then call a JSON API (saved homes). The first call gets you propertyIds; the second gets the home cards.
- **`{}&&` prefix on every stingray response.** This is Redfin's anti-CSRF measure — a literal four-byte prefix before the JSON body that would crash a naive `JSON.parse`. `RedfinClient.fetchStingrayJson` strips it. Don't try to parse stingray responses with `fetchJson` — it will fail.
- **Envelope checks.** Stingray responses always wrap data in `{version, errorMessage, resultCode, payload}`. `fetchStingrayJson` throws on `resultCode !== 0`.
- **Property-details takes two round trips.** The web app makes the same two calls: `initialInfo?path=<URL>` returns the propertyId+listingId, then `aboveTheFold?propertyId=…&listingId=…` returns the data. Pass `property_id`+`listing_id` directly to `redfin_get_property` to skip the first call.
- **Region IDs and types** are Redfin-internal. `region_type=6` covers cities and neighborhoods. The `id` field in `location-autocomplete` responses is formatted `"<type>_<region_id>"`; `parseRegionId` parses it.
- **Saved searches data is sparse.** Redfin's `/myredfin/saved-searches` page renders entries through React Server Components — there's no clean JSON endpoint. We regex-extract `/{city,zipcode,neighborhood,county,state}/...` URLs and their adjacent display text from the HTML. Best-effort; field shape may evolve.
- **Sign-in detection.** `src/client.ts::throwIfSignInPage` flags `/login` URL redirects and the AWS WAF challenge interstitial (body matches both `awswaf.com` AND `challenge.js` AND body < 80KB). We deliberately do NOT body-match `/login` since every signed-in page has a "Sign in" link in its nav.

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

## Versioning

Version appears in SEVEN places — all must match. `release-please-config.json` registers them as `extra-files` and bumps them in one PR per release:

1. `package.json` → `"version"`
2. `package-lock.json` → kept in sync by `npm install --package-lock-only`
3. `src/index.ts` → `VERSION` const (annotated with `// x-release-please-version`) + startup banner
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version`
6. `.claude-plugin/plugin.json` → `"version"`
7. `.claude-plugin/marketplace.json` → `metadata.version` + `plugins[].version`

### Release flow

Commits land on `main` via PR. release-please (`.github/workflows/release-please.yml`) opens or updates a release PR whenever Conventional-Commit messages (`feat:`, `fix:`, etc.) accumulate. Merging the release PR creates the tag and a GitHub Release; the `publish` job then packs `.mcpb` + `.skill`, publishes to npm with provenance, and pushes to the MCP Registry.

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. release-please owns versioning.

## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Direct pushes to `main` skip review *and* the auto-generated release notes block (configured in `.github/release.yml`).

For every PR, apply exactly one label:

| Label                  | Section in release notes |
|------------------------|--------------------------|
| `enhancement`          | Features                 |
| `bug`                  | Bug Fixes                |
| `security`             | Security                 |
| `refactor`             | Refactor                 |
| `documentation`        | Documentation            |
| `test`                 | Tests                    |
| `dependencies`         | Dependencies             |
| `ci` / `github_actions`| CI & Build               |
| *(none / unmatched)*   | Other Changes            |
| `ignore-for-release`   | Hidden from notes        |

Open with `gh pr create --label <label>`, then `gh pr merge <num> --auto --squash`. Repo allows squash-merge only — never `--merge`/`--rebase`.

## What to not do

- Don't add IP-rotation / TLS-impersonation tricks. v0.1's whole design is "the fetchproxy bridge is the bot-bypass strategy." Adding cycletls / curl-impersonate / Playwright is duplicate engineering and won't beat AWS WAF anyway.
- Don't paste cookies or env-configure auth. Auth lives in the browser.
- Don't register tools that can't be tested against a mock `RedfinClient`. All tool logic should be behind `fetchHtml` / `fetchStingrayJson` so tests can drive it without a real WS.
- Don't parse `/stingray/...` responses with anything other than `fetchStingrayJson`. The `{}&&` prefix and envelope check matter.
- Don't bump versions speculatively. release-please owns that.
