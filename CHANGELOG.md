# Changelog

## [1.3.4](https://github.com/alperu/soundsuite/compare/v1.3.3...v1.3.4) (2026-08-31)


### Features

* **admin:** log-off button moved to left nav sidebar below Docs link (single instance, session-aware) ([f1bfde8](https://github.com/alperu/soundsuite/commit/f1bfde88dcd7193e1947445ede7e28063cd382cf))
* **admin:** move log-off button below docs panel; hide sidebar on standalone login page ([7529a9f](https://github.com/alperu/soundsuite/commit/7529a9fa5f3e6a01e1c0d39bd2c1d103ad9e8533))
* **admin:** show logged-in username above log-off button in sidebar ([2fedb2f](https://github.com/alperu/soundsuite/commit/2fedb2fb216d0e7e4254092b6d35f5be0c024d70))
* **admin:** Users, Sessions, and Cloudflare tabs with cookie-based admin login ([8a0e05d](https://github.com/alperu/soundsuite/commit/8a0e05ded19104d3c3a21bccd9c06ab19732331a))


### Bug Fixes

* **scope:** multi-ref hub press opens the per-link menu instead of grabbing blind ([b622f4f](https://github.com/alperu/soundsuite/commit/b622f4fcd539f0e6efe4101a7823bb08b6dd5bcf))


### Performance Improvements

* **mcp:** cap query_case_knowledge rerank pool (115s→~5s), add phase timing + dev HMR registry rebuild; add MCP improvements report ([8fc8da6](https://github.com/alperu/soundsuite/commit/8fc8da6272dbf48e40a14e115b9b880f42b46bae))


### Miscellaneous Chores

* pin next release ([422c62e](https://github.com/alperu/soundsuite/commit/422c62ec7b4a51d7961b929ecd253bdcd5172552))

## [1.3.3](https://github.com/alperu/soundsuite/compare/v1.3.2...v1.3.3) (2026-08-20)


### Features

* **scope:** dedicated linkTo lane — target-first drags work on occupied hubs ([79ecb17](https://github.com/alperu/soundsuite/commit/79ecb1703681b414a3550ba2b85f237b162e3335))
* **scope:** full motion names + every writable slot visible when empty ([fde91a6](https://github.com/alperu/soundsuite/commit/fde91a623cba6309094cdafb958b888bdea9544d))
* **scope:** orderRef edges render + hub gains a safe press row ([319f8bf](https://github.com/alperu/soundsuite/commit/319f8bf8d0c12a58fe3f44c002b80aa743ea2a7e))


### Bug Fixes

* **scope:** orders expose a writable motionRef input on both surfaces ([581f880](https://github.com/alperu/soundsuite/commit/581f8804416f5401c32a365e4ab8ba479966bdd0))
* **scope:** records kinds offer only caseRef; held orderRef renders; aimed drags never write a different fact ([69f5619](https://github.com/alperu/soundsuite/commit/69f5619c7129f8be984f7a1901e8c6cee9d2c3e8))
* **scope:** slot rows arm link drags + atomic entity-row materialisation ([8cfa408](https://github.com/alperu/soundsuite/commit/8cfa408a3b5a4003f188dda94b0e56ea301a42e6))
* **scope:** whole block is a drop target — drag-to-link no longer requires hitting a 7px socket ([06d0338](https://github.com/alperu/soundsuite/commit/06d0338e109a7a35bbaa3491465a5afe97f4b0a9))


### Miscellaneous Chores

* pin next release ([4ccac47](https://github.com/alperu/soundsuite/commit/4ccac4732496bd1a0b68f65740851a854256351d))

## [1.3.2](https://github.com/alperu/soundsuite/compare/v1.3.1...v1.3.2) (2026-08-14)


### Features

* **scope+test:** containment fan router, test-infra archaeology paid down ([ad8a340](https://github.com/alperu/soundsuite/commit/ad8a3407ab3e41f132f24440e711dae678e0293b))
* **scope:** complete linking UX — badges, menus, picker, pairing workbench ([2898798](https://github.com/alperu/soundsuite/commit/2898798384d5087ae10f4bc60daa8ac3294f4657))
* **scope:** Haystack Block View — visual scope editor, entity linking, and search-scope override ([dbadca4](https://github.com/alperu/soundsuite/commit/dbadca4b27da18c39e2580c617b672fcbe0512ed))
* **scope:** selection-persistent edges, attachment→order links, Haystack Management nav ([e1ca5fd](https://github.com/alperu/soundsuite/commit/e1ca5fdebb03d6e73668a1cbbc2e23803ae4d512))
* **scope:** zoom-compensated slot labels + layout polish ([4affaaf](https://github.com/alperu/soundsuite/commit/4affaaf6a975177eb2b823bbd5de7e54bca27eda))


### Bug Fixes

* **scope:** edge-to-circle alignment corpus-wide, show-all includes containment, pin-until-hide links ([02d7e0f](https://github.com/alperu/soundsuite/commit/02d7e0f2500cd27397d95c369f99dddecebb5f5c))
* **scope:** real clicks select blocks, ref edges route through channels, panel opens the entity's own row ([7caacf6](https://github.com/alperu/soundsuite/commit/7caacf62356a44d7fc4ebf609aa053206cbd0f0e))


### Miscellaneous Chores

* sync release-please manifest to v1.3.1, pin next release ([df528b9](https://github.com/alperu/soundsuite/commit/df528b9d0ee37c210cfece5a1d67f0bb830c0d34))

## [1.3.1](https://github.com/alperu/soundsuite/compare/v1.3.0...v1.3.1) (2026-08-12)

### Features

* **search:** server-persisted search presets — SearchPreset table + /api/search/presets CRUD, one-time IndexedDB migration, preset dropdown right-aligned in the top bar ([6edfa6e](https://github.com/alperu/soundsuite/commit/6edfa6e))
* **search:** deep-search research trace streams into a collapsible Thoughts panel (plain-text rendering, auto-open while streaming) and persists on the turn for history replay ([6edfa6e](https://github.com/alperu/soundsuite/commit/6edfa6e))
* **ai:** per-model capability registry (effort tiers + request-param routing, output-token param, temperature tolerance, thinking applicability) driving the draft panel, MCP ai-helper, and summarizer; model list refresh with Gemini in the provider fallback order ([57278b0](https://github.com/alperu/soundsuite/commit/57278b0))
* **ai:** prompt caching — cacheTtl setting (default 1h) for deep search ([9df1f04](https://github.com/alperu/soundsuite/commit/9df1f04))


### Bug Fixes

* **search:** synthesis no longer leaks raw retrieved evidence into the answer — closing instruction after the excerpt block, 24K shared history cap, preamble splitter safety net, and a clear error instead of a context dump when synthesis produces nothing ([6edfa6e](https://github.com/alperu/soundsuite/commit/6edfa6e))
* **search:** module-scoped chat session id — conversations survive the Deep/Compare route-segment remount ([9ab4a37](https://github.com/alperu/soundsuite/commit/9ab4a37))
* **search:** history sessions keep source provenance across save/reload ([95f8ce5](https://github.com/alperu/soundsuite/commit/95f8ce5))
* **search:** per-token thoughts accumulation was O(N²); now a single accumulating string ([6edfa6e](https://github.com/alperu/soundsuite/commit/6edfa6e))

## [1.3.0](https://github.com/alperu/soundsuite/compare/v1.2.0...v1.3.0) (2026-08-10)

### Features

* **docparse:** hybrid structured document parsing — pdfjs block extraction (headings, paragraphs, tables, figures, page furniture) + OCR task escalation with OTSL table output, block-aware StructuredChunker, persisted page structure ([06ea50a](https://github.com/alperu/soundsuite/commit/06ea50a), [f556a4f](https://github.com/alperu/soundsuite/commit/f556a4f), [5efaa14](https://github.com/alperu/soundsuite/commit/5efaa14), [5ccd934](https://github.com/alperu/soundsuite/commit/5ccd934), [e66684b](https://github.com/alperu/soundsuite/commit/e66684b))
* **metaview:** Meta View structure inspector at /vectors/metaview — bounding-box overlays, RR speaker coloring + legend, figure-OCR overlay, stored-chunk view ([eb9de9a](https://github.com/alperu/soundsuite/commit/eb9de9a), [69a51f5](https://github.com/alperu/soundsuite/commit/69a51f5), [8ced971](https://github.com/alperu/soundsuite/commit/8ced971))
* **rr:** Reporter's Record transcript structure with line numbers — chunk text byte-identical, block-derived line stamping ([2aba21f](https://github.com/alperu/soundsuite/commit/2aba21f), [1cafb52](https://github.com/alperu/soundsuite/commit/1cafb52))
* **search:** structural metadata end-to-end — block type / heading path / speakers / table markdown columns, ranking boosts + structure hints, table markdown in synthesis, result breadcrumbs, MCP + operator-view parity ([1880d15](https://github.com/alperu/soundsuite/commit/1880d15), [2d35013](https://github.com/alperu/soundsuite/commit/2d35013), [0f388d7](https://github.com/alperu/soundsuite/commit/0f388d7), [9dd9073](https://github.com/alperu/soundsuite/commit/9dd9073))
* **readiness:** AI readiness scoring — v2 page-average model with integrity floor, per-page PageScore + per-chunk scores, blank-page classification, backfill endpoint, score surfaces on documents/vectors/pagereport ([aa874fe](https://github.com/alperu/soundsuite/commit/aa874fe), [6a6525f](https://github.com/alperu/soundsuite/commit/6a6525f))
* **ocr:** PaddleOCR-VL-1.6 vision model option with fixed-task prompts and model-aware fleet eligibility (Docker-only models excluded from Mac hosts at catalog, assignment, push, and routing layers) ([b450a5e](https://github.com/alperu/soundsuite/commit/b450a5e))
* **vectors:** URL-addressable tools (/vectors/{tool}/{filter}/{selection}), persisted per-tool settings, sortable headers, page-image viewer segment ([d2831d3](https://github.com/alperu/soundsuite/commit/d2831d3), [00061da](https://github.com/alperu/soundsuite/commit/00061da), [2d3c8ac](https://github.com/alperu/soundsuite/commit/2d3c8ac))
* **render:** pdftoppm-first page rendering with immutable browser caching and adjacent-page warming ([15c4355](https://github.com/alperu/soundsuite/commit/15c4355), [64b509d](https://github.com/alperu/soundsuite/commit/64b509d))


### Bug Fixes

* **ingestion:** garbled (CID) text layers are detected and force-OCR'd at ingest; image-less pages get a full-page render fallback instead of being skipped — repairs survive reprocessing ([ca2663b](https://github.com/alperu/soundsuite/commit/ca2663b))
* **ocr:** quality gate for observed garbage classes (repetition loops, unexpected script, LaTeX recitation, letter soup); run-together rejection is a character-ratio test with URL/email/path whitelisting instead of any-single-token ([04e43b4](https://github.com/alperu/soundsuite/commit/04e43b4), [d56a23b](https://github.com/alperu/soundsuite/commit/d56a23b))
* **embedding:** per-batch retry with exponential backoff, failed-host exclusion via fleet re-resolution, and a request timeout — one host disconnect no longer fails the document ([84d107d](https://github.com/alperu/soundsuite/commit/84d107d))
* **reindex:** targeted per-page extraction (whole-document pass eliminated), docparse structure parity, ink-verified blank classification, overall-progress display for batch repairs ([6a6525f](https://github.com/alperu/soundsuite/commit/6a6525f))
* **render:** CID-keyed font CMaps load correctly — pages with damaged embedded fonts no longer render body-less ([15c4355](https://github.com/alperu/soundsuite/commit/15c4355))
* **pipeline:** structure stage publishes live per-page progress with a heartbeat — long runs no longer display "Starting…" ([3316d8c](https://github.com/alperu/soundsuite/commit/3316d8c))
* **vectors:** pagereport re-syncs URL params on soft navigation (?status= filters apply without a fresh load) ([c7d2bc2](https://github.com/alperu/soundsuite/commit/c7d2bc2))
* **privacy:** repository rule + scrub — no case-identifying data in tracked files or commit messages; synthetic test fixtures ([dc829f5](https://github.com/alperu/soundsuite/commit/dc829f5), [fcf2103](https://github.com/alperu/soundsuite/commit/fcf2103))

## [1.2.0](https://github.com/alperu/soundsuite/compare/v1.1.0...v1.2.0) (2026-06-22)


### Features

* **gpu:** admin-configurable per-model GPU weight (--gpu-memory-utilization) ([de4a543](https://github.com/alperu/soundsuite/commit/de4a543ede0286ca168c10e8240ecad317378203))
* **gpu:** raise shipped reranker gpu-memory-utilization default 0.6 → 0.85 ([dd9ff36](https://github.com/alperu/soundsuite/commit/dd9ff368328db6ec9cda59e6a10815c068d158b2))
* **rerank:** operator-tunable interactive timeout + enforce-eager toggle ([41261b0](https://github.com/alperu/soundsuite/commit/41261b070c656f56897c514a9b1fc8033f814c63))
* **rerank:** pool-size setting + explicit reranker restart on container-arg change ([ed64f34](https://github.com/alperu/soundsuite/commit/ed64f34e5ec31779ec25229f9b727d315d89fc77))


### Bug Fixes

* **rerank:** always push reranker gpu-memory-utilization default (0.85) ([1dfc0d9](https://github.com/alperu/soundsuite/commit/1dfc0d9f6f490852db89357090df931730e503a9))

## [1.1.0](https://github.com/alperu/soundsuite/compare/v1.0.2...v1.1.0) (2026-06-10)


### Features

* **ai:** add Claude Fable 5 to model picker ([435903d](https://github.com/alperu/soundsuite/commit/435903dda54b8940e8ad8faa8480d36b0dd2f757))
* **gpu:** add ss-code-embedding role (jina-code-embeddings-1.5B) across admin + sidecar ([31e3927](https://github.com/alperu/soundsuite/commit/31e3927fb43f91a5ea2951d000382a7213af3d3d))
* **ui:** add SoundSuite brand logo to sidebar + app favicon ([c3fb40e](https://github.com/alperu/soundsuite/commit/c3fb40ed5467993667caff2927dff9a97c2f86df))


### Bug Fixes

* **code-embedding:** pull jina model via hf.co GGUF ref (was unpullable bare name) ([fbd6ba8](https://github.com/alperu/soundsuite/commit/fbd6ba89bd259fdb2b748f0bb1982271dc0503f9))
* **deep-search:** only honor and/or operators inside {{ }} chips ([9b15196](https://github.com/alperu/soundsuite/commit/9b151960f462b494218f5643b84c39431a786849))
* **deep-search:** prevent blank Fable 5 synthesis at high effort ([6c9428d](https://github.com/alperu/soundsuite/commit/6c9428dc78f0bc62acd26f5a79f77155540660aa))
* **search:** only run Axon boolean validation inside {{ }} chips ([1decabd](https://github.com/alperu/soundsuite/commit/1decabdd56f28e230ae227624aa0799fcb17e95b))
* **search:** persist per-turn deletion in chat history ([03e4725](https://github.com/alperu/soundsuite/commit/03e4725ca1cfd86ed448d8e3de5d4c5d4204a145))

## 1.0.2 (2026-06-08)

### Bug Fixes

- **RLM Deep Search synthesis no longer loops.** The recursive evidence-gathering loop could
  exhaust its rounds without producing a report ("RLM synthesis failed: tool-use loop exceeded
  maxRounds"). Fixed by capping the seed context fed to the RLM and forcing a final answer on
  the last round, so the gathered evidence always reaches the synthesis stage.
- **RLM tool calls now parse correctly.** Switched the vLLM tool-call parser to `qwen3_xml`
  (the format the model actually emits) so tool calls are structured instead of relying on a
  regex fallback.
- **RLM context window corrected** to the model's native 40960 tokens (was an invalid 65536
  that prevented vLLM from starting), with `fp8` KV cache and dedicated-GPU utilization.
- Deep Search synthesis follows the model you select — no hardcoded default.

### Internal

- Pinned the vLLM image (`v0.21.0`) for reproducible RLM/reranker serving (sidecar v2.3.69).
- Decomposed the 1,968-line Haystack `[op]` route into focused `lib/haystack/*` modules
  (cache, refs, entities, ensure-filing, commit) with a typed op-handler registry.
- Recovered ~22 API route tests that silently never ran (jsdom → node test env) and rewrote
  the stale `mcp-api` / `exhibits` suites.
- RLM serving reference added: `docs/rlm-endpoint.md`.

## 1.0.1 (2026-06-08)

### Features

- **XETO / Project Haystack legal data model.** Cases, motions, filings, persons
  (judge / movant / respondent / clerk / reporter), exhibits, and hearings are now
  first-class, typed entities with tag-based references — so the system understands the
  structure of a case, not just its text. Models are assigned per-motion via a structured
  tag panel (`caseRef`, `judgeRef`, `fileRef`, amendment/supersession links), and refs
  resolve to live entity records.
- **Graph-aware retrieval.** New `query_case_graph` MCP tool (amendment lineage,
  motions-by-person, related-motions) traversing the entity graph, wired into the RLM tool
  loop so the agent can choose structural lookups.
- **Adaptive-RAG query router** (opt-in "Auto"): picks single-shot / deep / RLM per query.
- **RLM (Recursive Language Model)** evidence-gathering with context-budget enforcement and
  tool-result caps.
- **Docker packaging:** multi-stage image (`node:22-bookworm-slim`), `docker compose`,
  GHCR publish, and a buildable release zip. A blank database is created on first run; no
  data is baked into the image.
- **Automated releases** (release-please + Conventional Commits) and a CI build/test workflow.
- Hybrid-fusion constants (RRF `k`, soft-boost) are now configurable.

### Bug Fixes

- Search: materialized `{{ }}` filter chips now travel into the submitted query (fixes
  intermittent "0 matches").
- Deep Search is reachable when a filter chip is applied.
- Reranker: shorter interactive timeout with graceful first-stage fallback (no more 90 s
  hangs) and an explicit "results not reranked" signal.
- `next build` / the Docker image now build cleanly; eliminated `.next/standalone`
  over-tracing bloat (≈245 MB image).

### Build / Infrastructure

- Prisma 7 with the native `better-sqlite3` driver adapter; Next.js 16.2 (Turbopack
  production builds); Claude Opus 4.8 support.
