# CLAUDE.md — redfin-mcp

Guidance for Claude working in this repo.

## TL;DR

Redfin MCP server. Default and only transport: localhost WebSocket via [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) — the companion browser extension is installed separately rather than embedded. Every HTTP call to redfin.com is dispatched through the user's signed-in Chrome tab — each request rides their existing session (cookies, TLS, JS context) exactly as if they'd clicked it themselves.

This is a "Pattern A" fetchproxy MCP (every call rides through fetchproxy), not "Pattern B" (one bootstrap call then direct fetch). Redfin validates each request at the session level, so the in-session routing has to be per-call.

## Tool surface

| Tool | File | Endpoint(s) | Kind |
| --- | --- | --- | --- |
| `redfin_search_properties` | `tools/search.ts` | (a) `GET /stingray/do/location-autocomplete?location=…` → region OR address<br>(b) `GET /stingray/api/gis?region_id=…&region_type=…&…` (region path) — address path short-circuits to a 1-result reply | read |
| `redfin_get_by_address` | `tools/get-by-address.ts` | `GET /stingray/do/location-autocomplete?location=…` → first `Addresses` row → parse `/home/<id>` | read |
| `redfin_get_property` | `tools/properties.ts` | (a) `GET /stingray/api/home/details/initialInfo?path=…` → propertyId+listingId<br>(b) `GET /stingray/api/home/details/aboveTheFold?propertyId=…&listingId=…` | read |
| `redfin_get_property_photos` | `tools/photos.ts` | (a) optional `initialInfo` to resolve IDs<br>(b) `GET /stingray/api/home/details/aboveTheFold?…` (mediaBrowserInfo.photos[]) | read |
| `redfin_get_market_report` | `tools/market.ts` | `GET /stingray/api/region/<region_type>/<region_id>/<property_type>/market-trends` | read |
| `redfin_get_price_history` | `tools/history.ts` | `GET /stingray/api/home/details/belowTheFold?propertyId=…&listingId=…` | read |
| `redfin_compare_properties` | `tools/compare.ts` | `GET /stingray/api/home/details/aboveTheFold?…` ×N (concurrent) | read |
| `redfin_bulk_get` | `tools/bulk-get.ts` | per-target ATF/BTF (+optional `/home/<id>` redirect resolve) ×N (≤200, concurrent, per-row errors, hard deadline) | read |
| `redfin_resolve_addresses` | `tools/resolve-addresses.ts` | `GET /stingray/do/location-autocomplete?location=…` ×N (≤100, concurrent) → URL/home_id per row | read |
| `redfin_get_climate_risk` | `tools/climate.ts` | `GET /<homedetails-path>` HTML — extract `floodData`/`fireData`/`heatData` blocks | read |
| `redfin_get_climate_risk_bulk` | `tools/climate.ts` | per-property climate HTML extract ×N (≤100, concurrent) — preserves order, per-row `available:false` | read |
| `redfin_get_area_climate_baseline` | `tools/climate.ts` | climate HTML extract over 2–10 sample URLs → averaged baseline + shared `cluster_id` | read |
| `redfin_get_comparable_rentals` | `tools/rentals.ts` | `GET /stingray/api/home/comparable-rentals?propertyId=…&rentEstimateLow=…&rentEstimateHigh=…` | read |
| `redfin_get_saved_homes` | `tools/saved.ts` | (a) `GET /myredfin/favorites` HTML → regex propertyIds<br>(b) `GET /stingray/do/api/v3/favorites/homecards?b=<csv-ids>` — image URLs constructed locally from mlsId+dataSourceId | read (auth) |
| `redfin_get_saved_searches` | `tools/saved.ts` | `GET /myredfin/saved-searches` HTML → regex region URLs | read (auth) |
| `redfin_calculate_mortgage` | `tools/mortgage.ts` | (local; no network) | read |
| `redfin_calculate_affordability` | `tools/affordability.ts` | (local; no network) | read |
| `redfin_healthcheck` | `tools/healthcheck.ts` | `GET /robots.txt` round-trip through fetchproxy + bridge status | read |
| `redfin_register_session` | `tools/sessions.ts` | (local; no network) — params: `account_identity` (**required**, min 1), `auth_expires_at?` | write (registry) |
| `redfin_set_active_session` | `tools/sessions.ts` | (local; no network) — param: `session_id` | write (registry) |
| `redfin_get_session_context` | `tools/sessions.ts` | (local; no network) — no params | read |

The session trio is the fleet-shared `registerSessionTools` from [`@chrischall/mcp-utils/session`](https://github.com/chrischall/mcp-utils) (prefix `redfin`), backed by the shared `createSessionRegistry()`. `redfin_register_session` takes the shared **`account_identity`** param (required) — re-registering the same identity updates the existing entry in place rather than adding a duplicate. (Breaking change in this adoption: the old optional `account_label` param was replaced by the required `account_identity` to match zillow/homes.)

All `/stingray/...` JSON responses begin with a `{}&&` anti-CSRF prefix; `RedfinClient.fetchStingrayJson` strips it. The two HTML-scraped tools (saved homes, saved searches) use regex extraction since Redfin's user-facing pages are React Server Components — there's no embedded `__NEXT_DATA__` blob like Zillow has.

## Architecture

```
src/
  index.ts              # entry — builds FetchproxyTransport, RedfinClient,
                        #   registers tool groups, connects stdio transport
  transport.ts          # RedfinTransport interface
  transport-fetchproxy.ts # thin class over @chrischall/mcp-utils/fetchproxy's
                        #   createFetchproxyTransport verb adapter (fetch/
                        #   runProbe/status); keeps the redfin startup banner
  client.ts             # RedfinClient.fetchHtml / fetchStingrayJson
                        #   + sign-in detection (WAF challenge / /login redirect)
                        #   + stripStingrayPrefix helper
  autocomplete.ts       # resolveRegion / resolveAddress / resolveBoth:
                        #   free-text → region_id+region_type (Places) or
                        #   home_id+url (Addresses) via
                        #   /stingray/do/location-autocomplete
  url.ts                # urlToPath — reduce a Redfin URL or bare path
                        #   to its path+search portion
  suffix.ts             # expandAddressVariants — Rd ↔ Road street-suffix swaps
  geo.ts                # ZIP → plausible-state guard (homesMatchZipState)
  derived.ts            # thin adapters over @chrischall/realty-core derived
                        #   fields (lot_size_acres, price_drop_*, last_sold_*, …)
  features.ts           # extractFeatures — structured listing-feature flags
  resolve.ts            # shared address-resolution rung ladder + per-locality
                        #   pool cache (get_by_address + resolve_addresses)
  mcp.ts                # textResult() result-wrapper + unwrapValue() helper
  tools/                # one registerXxxTools(server, client) per file (16):
    search.ts           # redfin_search_properties (buildGisPath + formatHome)
    properties.ts       # redfin_get_property (initialInfo + ATF/BTF)
    get-by-address.ts   # redfin_get_by_address (single-address resolve)
    bulk-get.ts         # redfin_bulk_get (concurrent ATF/BTF fan-out)
    compare.ts          # redfin_compare_properties (side-by-side + summary)
    photos.ts           # redfin_get_property_photos (mediaBrowserInfo gallery)
    history.ts          # redfin_get_price_history (belowTheFold events)
    market.ts           # redfin_get_market_report (market-trends endpoint)
    climate.ts          # redfin_get_climate_risk + _climate_risk_bulk
                        #   + _get_area_climate_baseline (flood/fire/heat
                        #   First Street HTML extract; bulk + cluster baseline)
    rentals.ts          # redfin_get_comparable_rentals
    saved.ts            # redfin_get_saved_homes + redfin_get_saved_searches
                        #   (HTML extract → optional homecards API)
    resolve-addresses.ts # redfin_resolve_addresses (bulk address → URL/home_id)
    mortgage.ts         # redfin_calculate_mortgage (local PITI; realty-core)
    affordability.ts    # redfin_calculate_affordability (local DTI; realty-core)
    healthcheck.ts      # redfin_healthcheck (bridge probe)
    sessions.ts         # thin wrapper over @chrischall/mcp-utils/session's
                        #   registerSessionTools (prefix 'redfin') —
                        #   redfin_{register,set_active,get_session_context}.
                        #   The registry is the shared createSessionRegistry(),
                        #   constructed in index.ts and passed in.

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
REDFIN_WS_PORT=37149                            # override the fetchproxy WebSocket port
REDFIN_COMMUNITIES_FILE=/path/to/communities.json  # override community vocabulary (JSON string array)
```

## Conventions

- All tools prefixed `redfin_*`.
- Tool return shape: `textResult(data)` from `src/mcp.ts` → `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`. Don't hand-roll the wrapper.
- Tool annotations: every tool sets `title`, `readOnlyHint: true`, `idempotentHint: true`, and `openWorldHint`. The last is `true` for network-bound tools and `false` for `redfin_calculate_mortgage` (pure local computation).
- Path-only inputs to `RedfinClient`: pass `/some/path?with=query`, never a full URL. `FetchproxyTransport` prepends `https://www.redfin.com`. When a tool takes a `url` arg from the user, reduce it via `urlToPath` from `src/url.ts`.
- Always use `client.fetchStingrayJson(...)` for `/stingray/...` endpoints. Stingray responses carry a `{}&&` anti-CSRF prefix that has to be stripped, AND a `{resultCode, errorMessage, payload}` envelope that needs to be checked. The helper handles both.
- Write a failing test before implementation (TDD).
- ESM + NodeNext: imports use `.js` extensions even for `.ts` source.
- stdio transport: log warnings/banners to **stderr** only — stdout is reserved for JSON-RPC.

## Redfin quirks

- **No `__NEXT_DATA__`.** Redfin is a React Server Components app; the homepage and user pages do NOT embed a Next.js hydration blob. Tools that need data either (a) call a `/stingray/...` JSON API (search, property, market) or (b) regex-extract IDs from the page HTML and then call a JSON API (saved homes). The first call gets you propertyIds; the second gets the home cards.
- **`{}&&` prefix on every stingray response.** This is Redfin's anti-CSRF measure — a literal four-byte prefix before the JSON body that would crash a naive `JSON.parse`. `RedfinClient.fetchStingrayJson` strips it; parsing a stingray response without going through that helper will fail.
- **Envelope checks.** Stingray responses always wrap data in `{version, errorMessage, resultCode, payload}`. `fetchStingrayJson` throws on `resultCode !== 0`.
- **Property-details takes two round trips.** The web app makes the same two calls: `initialInfo?path=<URL>` returns the propertyId+listingId, then `aboveTheFold?propertyId=…&listingId=…` returns the data. Pass `property_id`+`listing_id` directly to `redfin_get_property` to skip the first call.
- **`property_id` alone resolves via the `/home/<id>` redirect (#89).** `initialInfo` will NOT resolve the bare `/home/<id>` path — it needs the full `/<STATE>/<City>/<Street>-<ZIP>/home/<id>` slug. So when a caller passes `property_id` with no `listing_id`/`url`, `RedfinClient.resolveCanonicalUrl(id)` GETs `/home/<id>`, lets the bridge follow Redfin's 301 to the canonical slug, and returns the redirected final URL (`FetchResult.url`); `resolveIds` then runs `initialInfo` on that slug. If the hop stays on the bare `/home/<id>` form (invalid/delisted id) it throws an actionable error. Used by `redfin_get_property` and `redfin_bulk_get`.
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

<!-- pr-workflow:v2 -->
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

The **PR title MUST be a Conventional Commit**, written user-facing (`fix(scope): …`, `feat(scope): …`), not internal shorthand. Because the repo squash-merges, the PR title *becomes the squash commit's subject line* — the only thing release-please parses to pick the version bump and changelog section. Only `feat` (minor), `fix` (patch), and `!`/`BREAKING CHANGE` (major) cut a release; `perf`/`refactor`/`docs` show in the changelog without bumping; `ci`/`test`/`build`/`chore` are recognised but hidden (see `release-please-config.json` → `changelog-sections`). A title without a conventional type is invisible to release-please — no bump, no changelog line. Prefixes in *individual commits* don't help; squash keeps only the title.

**Exception for first-party dependency bumps.** When bumping a package we own (currently `@fetchproxy/server` — anything published from a chrischall-owned repo), label the PR `enhancement` or `bug` instead of `dependencies`, and use the matching commit prefix (`feat:` or `fix:`) instead of `chore:`. Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden under "Dependencies" (which doesn't trigger a release).

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). On a `pass` OR `warn` (nits-only) verdict it adds the `ready-to-merge` label; a `warn` or `fail` also opens/updates an `auto-review-followup` issue capturing the findings. Only `fail` blocks the merge.
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

### Auto-review follow-up issues

When a PR's auto-review verdict is `warn` or `fail`, the `chrischall/workflows` pipeline opens or updates a single `auto-review-followup` issue ("Auto-review follow-ups for PR #N") whose checklist captures every finding, and links it from the PR's `<!-- auto-review-verdict -->` comment (`📋 Tracking follow-ups: #N`). `warn` (nits only) still auto-merges — the issue carries the nits forward, so most nits are fixed in a *later* PR; `fail` blocks until the important findings are addressed on the PR itself.

When asked to address the auto-review comments / review findings on a PR:

1. Read the verdict comment, open the linked `auto-review-followup` issue, and treat its checklist as the work list (alongside any inline review comments).
2. Resolve each item, checking off only what you've **verified** is genuinely fixed.
3. If every item is resolved on the current PR, add `Closes #<issue>` to that PR's body so the merge closes it; if some are deferred, check off only the resolved ones and leave the issue open.
4. For nits whose `warn` PR already auto-merged, address them in a follow-up PR that references `Closes #<issue>`.

(Mirrors the fleet-wide convention in `~/.claude/CLAUDE.md`.)

### PR timing — only open when the feature is done

Because PRs auto-merge as soon as auto-review passes, **do not open a PR until the feature is genuinely complete**. There's no draft-PR safety net here:

- Don't open a PR to "stage" work while live verification, follow-up fixes, or final passes are still pending — by the time you finish those, the half-baked PR may already be in `main`.
- Push commits to the branch first; only run `gh pr create` once tests pass, live verification (if applicable) is green, and you'd be comfortable with the change shipping as-is.
- If follow-ups land after a PR is already open, they need to land on the same branch *before* auto-review flips to `pass`. Once the PR squash-merges, late commits orphan onto a stale branch and become their own follow-up PR.
- If you genuinely need a checkpoint review without shipping, open the PR as a GitHub draft (`gh pr create --draft …`) — auto-review skips drafts. Mark it ready-for-review only when the feature is truly done.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

## What to not do

- Don't add IP-rotation or TLS-impersonation libraries. The whole design is "every request rides the user's own browser session via fetchproxy." Adding cycletls / curl-impersonate / Playwright would replace that with a separate stand-in identity — which both defeats the design and adds engineering surface.
- Don't paste cookies or env-configure auth. Auth lives in the browser.
- Don't register tools that can't be tested against a mock `RedfinClient`. All tool logic should be behind `fetchHtml` / `fetchStingrayJson` so tests can drive it without a real WS.
- Don't parse `/stingray/...` responses with anything other than `fetchStingrayJson`. The `{}&&` prefix and envelope check matter.
- Don't bump versions speculatively. release-please owns that.
