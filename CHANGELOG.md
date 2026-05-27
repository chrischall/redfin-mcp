# Changelog

## [0.6.0](https://github.com/chrischall/redfin-mcp/compare/v0.5.0...v0.6.0) (2026-05-27)


### Features

* **climate:** explicit availability shape + bulk + area baseline + landslide docs ([#51](https://github.com/chrischall/redfin-mcp/issues/51)-[#54](https://github.com/chrischall/redfin-mcp/issues/54)) ([#66](https://github.com/chrischall/redfin-mcp/issues/66)) ([7a7db8a](https://github.com/chrischall/redfin-mcp/commit/7a7db8a16a7a689fae14be120464e962a62c2cb5))
* fetchproxy SW eviction auto-retry + description honesty sweep + raise compare cap ([#55](https://github.com/chrischall/redfin-mcp/issues/55)-[#57](https://github.com/chrischall/redfin-mcp/issues/57)) ([#67](https://github.com/chrischall/redfin-mcp/issues/67)) ([bb674dc](https://github.com/chrischall/redfin-mcp/commit/bb674dcf3c2632a6efb65fd7cb39c6aed6321a8a))
* **history:** events_normalized + bundled history flags on get_property ([#65](https://github.com/chrischall/redfin-mcp/issues/65)) ([f0450b7](https://github.com/chrischall/redfin-mcp/commit/f0450b7de4297c725f8b4311f07a4192823f1f29))
* **p0/p1:** add redfin_bulk_get + redfin_resolve_addresses ([#61](https://github.com/chrischall/redfin-mcp/issues/61)) ([ed74ca5](https://github.com/chrischall/redfin-mcp/commit/ed74ca5cbb5a41ff4da2a703afb6fcac15bf2e3c))
* **p0:** default include_description=false + server-side extracted_features ([#58](https://github.com/chrischall/redfin-mcp/issues/58)) ([5b7c208](https://github.com/chrischall/redfin-mcp/commit/5b7c208e08bc6d56088d688a194bb413545d7447))
* **p1:** schema derivations — hoa, price-drop, tax, summary opt-in, portal hyperlink, address alternates, last_sold ([#60](https://github.com/chrischall/redfin-mcp/issues/60)) ([6b166cd](https://github.com/chrischall/redfin-mcp/commit/6b166cd0b4643e43fb76f18ccc4e0ffcee15661a))
* **p2:** add session registry + get_session_context + set_active_session ([#62](https://github.com/chrischall/redfin-mcp/issues/62)) ([bc4eacf](https://github.com/chrischall/redfin-mcp/commit/bc4eacf1a70a6f2f41e33b05ce0bd98639d93e5c))
* **search:** coverage field + ZIP-state guard + cap audit ([#45](https://github.com/chrischall/redfin-mcp/issues/45) [#46](https://github.com/chrischall/redfin-mcp/issues/46) [#47](https://github.com/chrischall/redfin-mcp/issues/47)) ([#64](https://github.com/chrischall/redfin-mcp/issues/64)) ([4dcf31b](https://github.com/chrischall/redfin-mcp/commit/4dcf31bda631db70c6f96e626c6d6057dd197355))
* **transport-fetchproxy,healthcheck:** adopt @fetchproxy/server 0.8.0 + surface bridge hints ([#70](https://github.com/chrischall/redfin-mcp/issues/70)) ([3252d21](https://github.com/chrischall/redfin-mcp/commit/3252d21ac6ab6c2e1eda781792acba9d0748fb5a))


### Bug Fixes

* **get-by-address:** retry with street-suffix abbreviation expansion ([#63](https://github.com/chrischall/redfin-mcp/issues/63)) ([191c55a](https://github.com/chrischall/redfin-mcp/commit/191c55a1ca620bf3895b2256d42e0e65ec4aade1))
* **p0:** address PR [#58](https://github.com/chrischall/redfin-mcp/issues/58) review nits — tighten marina regex, simplify partial-basement, doc env var ([#68](https://github.com/chrischall/redfin-mcp/issues/68)) ([384c0ad](https://github.com/chrischall/redfin-mcp/commit/384c0add45a5acf311f34d348667fd8031dae4f2))

## [0.5.0](https://github.com/chrischall/redfin-mcp/compare/v0.4.5...v0.5.0) (2026-05-26)


### Features

* add redfin_get_by_address and fix search address resolution ([#29](https://github.com/chrischall/redfin-mcp/issues/29)) ([a8489ef](https://github.com/chrischall/redfin-mcp/commit/a8489ef1d307dad42034976fba82c33ae8b54881))
* add redfin_healthcheck for end-to-end bridge diagnostics ([#27](https://github.com/chrischall/redfin-mcp/issues/27)) ([bb6946f](https://github.com/chrischall/redfin-mcp/commit/bb6946f14324b6e2d6d0ee574f08306b9bc9d5f8))


### Bug Fixes

* **properties:** return canonical URL when caller provides IDs only ([#30](https://github.com/chrischall/redfin-mcp/issues/30)) ([6dd51a2](https://github.com/chrischall/redfin-mcp/commit/6dd51a24e9b9feb1e89286807aa2e84e2527a179))

## [0.4.5](https://github.com/chrischall/redfin-mcp/compare/v0.4.4...v0.4.5) (2026-05-26)


### Documentation

* **claude:** warn against early PRs and call out first-party dep bumps ([#22](https://github.com/chrischall/redfin-mcp/issues/22)) ([76457e9](https://github.com/chrischall/redfin-mcp/commit/76457e9447ae1b6d6ae88fad9db0383e54f83e08))

## [0.4.4](https://github.com/chrischall/redfin-mcp/compare/v0.4.3...v0.4.4) (2026-05-25)


### Bug Fixes

* **ci:** prevent labeled event from cancelling auto-review ([#19](https://github.com/chrischall/redfin-mcp/issues/19)) ([4323eb4](https://github.com/chrischall/redfin-mcp/commit/4323eb45a43f6b485a8ff0eab7e35be11dfbb5af))

## [0.4.3](https://github.com/chrischall/redfin-mcp/compare/v0.4.2...v0.4.3) (2026-05-25)


### Bug Fixes

* **search+get_property:** catch gis silent fallback by homes, validate URL shape ([#16](https://github.com/chrischall/redfin-mcp/issues/16)) ([6546e4c](https://github.com/chrischall/redfin-mcp/commit/6546e4c1677aaa51540f149ab6ba648685115372))

## [0.4.2](https://github.com/chrischall/redfin-mcp/compare/v0.4.1...v0.4.2) (2026-05-24)


### Documentation

* canonical auto-merge guidance + softer fetchproxy framing ([#14](https://github.com/chrischall/redfin-mcp/issues/14)) ([789e113](https://github.com/chrischall/redfin-mcp/commit/789e11315f5fb89b3a2483f15df5d9b96f6304cb))

## [0.4.1](https://github.com/chrischall/redfin-mcp/compare/v0.4.0...v0.4.1) (2026-05-24)


### Bug Fixes

* **history:** align with live belowTheFold shape (3 field mismatches) ([#12](https://github.com/chrischall/redfin-mcp/issues/12)) ([660363a](https://github.com/chrischall/redfin-mcp/commit/660363a46252605211984610aab0fd1eee793400))
* **market+search:** switch to market-trends endpoint + detect gis fallback ([#13](https://github.com/chrischall/redfin-mcp/issues/13)) ([9abe53c](https://github.com/chrischall/redfin-mcp/commit/9abe53c77b9f15440a9883a92a3b33095e6d554f))
* **photos:** omit per-photo source lists by default ([#10](https://github.com/chrischall/redfin-mcp/issues/10)) ([c943ad9](https://github.com/chrischall/redfin-mcp/commit/c943ad97b2fbbc81fb4e65f0f097324b6104ce2a))

## [0.4.0](https://github.com/chrischall/redfin-mcp/compare/v0.3.0...v0.4.0) (2026-05-24)


### Features

* property photo gallery + saved-home images ([#8](https://github.com/chrischall/redfin-mcp/issues/8)) ([2abbf59](https://github.com/chrischall/redfin-mcp/commit/2abbf596598957544fb940277d905b2e4edb6ca9))

## [0.3.0](https://github.com/chrischall/redfin-mcp/compare/v0.2.1...v0.3.0) (2026-05-24)


### Features

* v0.3 — climate-risk + 4 more tools (compare, price/tax history, comparable rentals, affordability) ([#6](https://github.com/chrischall/redfin-mcp/issues/6)) ([212cf4d](https://github.com/chrischall/redfin-mcp/commit/212cf4dbc672f57916ecef2306e152bb5e13b208))


### Documentation

* add Acknowledgement of Terms section to README ([#4](https://github.com/chrischall/redfin-mcp/issues/4)) ([3249b2e](https://github.com/chrischall/redfin-mcp/commit/3249b2ef2d4d79b4371d285db1aaa77af3c1fbf7))

## [0.2.1](https://github.com/chrischall/redfin-mcp/compare/v0.2.0...v0.2.1) (2026-05-23)


### Bug Fixes

* **server.json:** correct stale 'Zestimates' wording (Redfin doesn't have those) ([#2](https://github.com/chrischall/redfin-mcp/issues/2)) ([1592343](https://github.com/chrischall/redfin-mcp/commit/1592343349a88f36d98bea0cc639e3864eb6411b))

## [0.2.0](https://github.com/chrischall/redfin-mcp/compare/v0.1.0...v0.2.0) (2026-05-23)


### Features

* initial redfin-mcp scaffold ([4ec4ee7](https://github.com/chrischall/redfin-mcp/commit/4ec4ee7b06a93e87c20b433507951b35e8233ba7))
