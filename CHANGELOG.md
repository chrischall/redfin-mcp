# Changelog

## [0.9.5](https://github.com/chrischall/redfin-mcp/compare/v0.9.4...v0.9.5) (2026-06-15)


### Documentation

* correct .env.example service name and document all env vars ([#133](https://github.com/chrischall/redfin-mcp/issues/133)) ([5065121](https://github.com/chrischall/redfin-mcp/commit/5065121c24da3c3f91d2a24cdd5e5307d5848ec4))
* refresh CLAUDE.md tool surface + add auto-review follow-up convention ([#132](https://github.com/chrischall/redfin-mcp/issues/132)) ([31bc31a](https://github.com/chrischall/redfin-mcp/commit/31bc31a3d9fe028ae1ece4620b023edb8c9116c1))
* require Conventional Commit PR titles for release-please ([#128](https://github.com/chrischall/redfin-mcp/issues/128)) ([9c1a24b](https://github.com/chrischall/redfin-mcp/commit/9c1a24bc8f1a74145a51fe2dda5e9d3c6ebaea72))

## [0.9.4](https://github.com/chrischall/redfin-mcp/compare/v0.9.3...v0.9.4) (2026-06-13)


### Bug Fixes

* bot PRs bypass the CI gate unconditionally (upstream curtaincall[#86](https://github.com/chrischall/redfin-mcp/issues/86) review) ([#122](https://github.com/chrischall/redfin-mcp/issues/122)) ([d8051a4](https://github.com/chrischall/redfin-mcp/commit/d8051a4404ac7a58c4b3355f8ea2a4d3fb9f6c63))


### Documentation

* add MIT LICENSE file and README badges ([#119](https://github.com/chrischall/redfin-mcp/issues/119)) ([f7d02ec](https://github.com/chrischall/redfin-mcp/commit/f7d02ece25b9362b22ca23a16821cd5a1b5fa480))

## [0.9.3](https://github.com/chrischall/redfin-mcp/compare/v0.9.2...v0.9.3) (2026-06-10)


### Bug Fixes

* bound bulk_get + resolve_addresses with an overall deadline and classify row timeouts ([#114](https://github.com/chrischall/redfin-mcp/issues/114)) ([f94fcb3](https://github.com/chrischall/redfin-mcp/commit/f94fcb34ae12b5726449a8262d479c16c9d4b7ca))


### Refactor

* adopt mcp-utils 0.10.0 helpers (factory banner + runBoundedBatch) ([#118](https://github.com/chrischall/redfin-mcp/issues/118)) ([f3debe9](https://github.com/chrischall/redfin-mcp/commit/f3debe9fda5fcd163d434046e00127f52ec0ed72))
* **sessions:** adopt shared registerSessionTools ([#116](https://github.com/chrischall/redfin-mcp/issues/116)) ([cb05abd](https://github.com/chrischall/redfin-mcp/commit/cb05abd02ca1eff92f9cf43acc29b8a9cbc44e47))

## [0.9.2](https://github.com/chrischall/redfin-mcp/compare/v0.9.1...v0.9.2) (2026-06-07)


### Documentation

* neutral wording for fetchproxy routing in description ([#111](https://github.com/chrischall/redfin-mcp/issues/111)) ([2bfde97](https://github.com/chrischall/redfin-mcp/commit/2bfde97fc0e7c784adf2c6d0d9a3a1284602a879))

## [0.9.1](https://github.com/chrischall/redfin-mcp/compare/v0.9.0...v0.9.1) (2026-06-04)


### Bug Fixes

* adopt @fetchproxy/server 0.13.0 (bridge host failover + re-pairing) ([#105](https://github.com/chrischall/redfin-mcp/issues/105)) ([e52b21c](https://github.com/chrischall/redfin-mcp/commit/e52b21c226a5b64b825fe7616cd2e4f154f3baaf))
* adopt @fetchproxy/server 1.0.0 + @chrischall/mcp-utils 0.5.0 ([#107](https://github.com/chrischall/redfin-mcp/issues/107)) ([d0ee055](https://github.com/chrischall/redfin-mcp/commit/d0ee055032bc6a86d8062a5ce04464015d7de678))

## [0.9.0](https://github.com/chrischall/redfin-mcp/compare/v0.8.0...v0.9.0) (2026-05-29)


### Features

* adopt @fetchproxy/server 0.11.0 + @chrischall/realty-core 0.4.1 ([#96](https://github.com/chrischall/redfin-mcp/issues/96)) ([1790198](https://github.com/chrischall/redfin-mcp/commit/1790198c2177609976799e2935c6662bf73ffedc))
* resolve redfin_bulk_get and get_property from property_id alone ([#90](https://github.com/chrischall/redfin-mcp/issues/90)) ([b8f1c08](https://github.com/chrischall/redfin-mcp/commit/b8f1c081df1857c374a7717d116e2585d0b5aed4))


### Bug Fixes

* **ci:** arm auto-merge from verdict comment when structured_output is empty ([#94](https://github.com/chrischall/redfin-mcp/issues/94)) ([b4a494e](https://github.com/chrischall/redfin-mcp/commit/b4a494e7d53b4d962858d3b9558e2e24921d1692))
* **ci:** treat instant-merge race as success in auto-merge arm ([#93](https://github.com/chrischall/redfin-mcp/issues/93)) ([104e218](https://github.com/chrischall/redfin-mcp/commit/104e218b6912791d781495f49e282f557506aa12))
* classify bulk-get per-row errors via classifyRowError ([#92](https://github.com/chrischall/redfin-mcp/issues/92)) ([91c1942](https://github.com/chrischall/redfin-mcp/commit/91c1942c4821177510e8e452da27c145fdfd50fc))

## [0.8.0](https://github.com/chrischall/redfin-mcp/compare/v0.7.0...v0.8.0) (2026-05-29)


### Features

* adopt realty-core extractFeatures (canonical basement detector) + drop inline copy ([#87](https://github.com/chrischall/redfin-mcp/issues/87)) ([c6a4c1e](https://github.com/chrischall/redfin-mcp/commit/c6a4c1ee975b67fbd3d92f28c541e61f7b05b932))
* consume @chrischall/realty-core 0.3.0 — drop inline hoisted helpers ([#86](https://github.com/chrischall/redfin-mcp/issues/86)) ([565bf8f](https://github.com/chrischall/redfin-mcp/commit/565bf8f6b7c629c43b0b933678dc709a38f095b1))
* **properties:** parse lot_size and derive lot_size_acres ([#83](https://github.com/chrischall/redfin-mcp/issues/83)) ([99c6b5e](https://github.com/chrischall/redfin-mcp/commit/99c6b5eff088a94cc01230874608d0f0f7e30e9d))

## [0.7.0](https://github.com/chrischall/redfin-mcp/compare/v0.6.0...v0.7.0) (2026-05-28)


### Features

* migrate to @fetchproxy/server 0.9.x bulk helpers + opt into keepAliveIntervalMs ([#77](https://github.com/chrischall/redfin-mcp/issues/77)) ([40860e7](https://github.com/chrischall/redfin-mcp/commit/40860e771e6e66c73889a53eb9cb7883d7743651))
* **resolve:** add search-fallback rung (closes [#75](https://github.com/chrischall/redfin-mcp/issues/75)) ([#79](https://github.com/chrischall/redfin-mcp/issues/79)) ([71bd8af](https://github.com/chrischall/redfin-mcp/commit/71bd8af6c6076e074e94c46a06f607cbbdd635a5))


### Bug Fixes

* address review nits + add resolve.ts unit tests ([#72](https://github.com/chrischall/redfin-mcp/issues/72) follow-up) ([#76](https://github.com/chrischall/redfin-mcp/issues/76)) ([2f024c1](https://github.com/chrischall/redfin-mcp/commit/2f024c1b14a72179878c78e630b233242a8ca59e))
* **resolve:** bulk should run same rungs as single (closes [#71](https://github.com/chrischall/redfin-mcp/issues/71)) ([#72](https://github.com/chrischall/redfin-mcp/issues/72)) ([d132607](https://github.com/chrischall/redfin-mcp/commit/d13260734300097de12b7e42d6be15fc5b018bbd))

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
