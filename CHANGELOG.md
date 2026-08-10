# Changelog

## [1.3.0](https://github.com/alperu/soundsuite/compare/v1.2.0...v1.3.0) (2026-08-10)


### Features

* **admin:** OCR Performance card on /admin/ocr — concurrency + timeout sliders ([02865ad](https://github.com/alperu/soundsuite/commit/02865ad5c4b792dd79e995e2ab0f993cb561dd5b))
* **admin:** OCR Performance sliders on /admin/ocr ([d033193](https://github.com/alperu/soundsuite/commit/d033193fe4530ba65b7d45532b4f9a5710873cee))
* **docparse:** ALL-CAPS document titles become headings; Meta View page-list column titles ([67c4a7f](https://github.com/alperu/soundsuite/commit/67c4a7f17ae2180b1ec884db0e64393c53ffa397))
* **docparse:** born-digital lines[] hierarchy + Meta View paragraph-number toggle ([5bfcd56](https://github.com/alperu/soundsuite/commit/5bfcd5600370e98ffdae859e55de5f5f0e64aa59))
* **docparse:** figure blocks for embedded page images ([4c1157e](https://github.com/alperu/soundsuite/commit/4c1157e1f6ebded672dcaa5f5dabda69f1b3bb53))
* **docparse:** numbered-heading signal in the block extractor ([4f89355](https://github.com/alperu/soundsuite/commit/4f893552ef58c30cd77ce624f7e5e7338604bac3))
* **docparse:** OCR figure blocks and show the text in the Meta View overlay ([abb80e8](https://github.com/alperu/soundsuite/commit/abb80e85052f3b486c5faff617bdd59e5cd49f45))
* **docparse:** OTSL normalizer + pdf-block-extractor (hybrid steps 2a core) ([06ea50a](https://github.com/alperu/soundsuite/commit/06ea50a3a6d39e9f357cc257eb33b30f4ba8127b))
* **docparse:** real font names unlock the bold heading signal ([e7859d0](https://github.com/alperu/soundsuite/commit/e7859d08ea1310add16123ce8af26a78518c029b))
* **docparse:** region cropper + escalation orchestrator + pipeline wiring (steps 2b+3) ([f556a4f](https://github.com/alperu/soundsuite/commit/f556a4f3127fb30211b369ecc2aecb814e565681))
* **docparse:** ruled-table detection from drawn borders (task [#3](https://github.com/alperu/soundsuite/issues/3)) ([e66684b](https://github.com/alperu/soundsuite/commit/e66684b8fe54dd2b7dbbf366550d0e6c1e3e3e33))
* **docparse:** structure persistence (hybrid step 4) ([5ccd934](https://github.com/alperu/soundsuite/commit/5ccd934b377fb4bd8da8d2494d524d7fc78de3c8))
* **docparse:** StructuredChunker — block-aware chunking (hybrid step 5) ([5efaa14](https://github.com/alperu/soundsuite/commit/5efaa14d442fa8ffec1930dc84b826023af1da89))
* **fleet:** Ollama version-floor check for the OCR role ([b643500](https://github.com/alperu/soundsuite/commit/b6435007defe0877c7ce0ad1fa433d5518f0b068))
* **fleet:** surface Ollama version floor violations on the OCR row ([5c00d45](https://github.com/alperu/soundsuite/commit/5c00d452d7eebf571346992610d9140433a73a21))
* **metaview:** align figure OCR text to its position in the image ([8ced971](https://github.com/alperu/soundsuite/commit/8ced971ad657e3e18d045ed5e8204799f5c1c41b))
* **metaview:** Chunks view — stored chunk text beside page structure ([69a51f5](https://github.com/alperu/soundsuite/commit/69a51f50651146bdaa4442153d3185c9bc355973))
* **metaview:** click a figure to hide/show its OCR text overlay ([ddc328d](https://github.com/alperu/soundsuite/commit/ddc328dfac80238dfaa156a814effed0d0025796))
* **metaview:** color RR line overlay per speaker-turn paragraph ([79c68fe](https://github.com/alperu/soundsuite/commit/79c68fecb377f05479f2df1af5719389001b7200))
* **metaview:** RR overlay legend — speaker/type + line range per color at the bottom ([47872b4](https://github.com/alperu/soundsuite/commit/47872b402430983d40bc17976e9e58015b4ceda9))
* **ocr:** admin UI slider for pipeline.ocrTimeoutMs ([d382f73](https://github.com/alperu/soundsuite/commit/d382f73be11a2783f476121db712e9cf1687a6c7))
* **ocr:** per-request task selection (steps 1a+1b of hybrid docparse plan) ([b450a5e](https://github.com/alperu/soundsuite/commit/b450a5e234da998eed438b511d96bcd66d011e1e))
* **ocr:** Phase 0 results — Table Recognition emits OTSL; gate accepts it ([6802397](https://github.com/alperu/soundsuite/commit/68023973526ae9a038bc2ddf938b4faaa717ce42))
* **ocr:** Phase 2 robustness — configurable timeout, ocrFailedCount, split concurrency knobs ([2c8472c](https://github.com/alperu/soundsuite/commit/2c8472ca3d492f0198078bf054af680cb7156210))
* **ocr:** Phase 2 robustness — configurable timeout, ocrFailedCount, split concurrency knobs ([e336e51](https://github.com/alperu/soundsuite/commit/e336e510c00d91542b5ac1bc05dfe6ffc88a2b40))
* **readiness:** AI readiness score module + backfill endpoint ([aa874fe](https://github.com/alperu/soundsuite/commit/aa874fe6f0987c9c84e53e813570b6e0c1d5a630))
* **rr:** block-derived line stamping behind comparison logging ([1cafb52](https://github.com/alperu/soundsuite/commit/1cafb52a2fc3b9b54fb8be0fae8c901687d73ff8))
* **rr:** schema deltas + structureOnly twin flags (PLAN-rr-structure items 4-5) ([a0bd298](https://github.com/alperu/soundsuite/commit/a0bd29806bddb6d71ad72bc4d3d9c6174bb1f276))
* **rr:** transcript structure with line numbers, chunk text byte-identical ([2aba21f](https://github.com/alperu/soundsuite/commit/2aba21feaafd3f874d17fda79c676c361356c648))
* **search:** phase-1 structure metadata — columns, RR speakers, boosts, grounding ([1880d15](https://github.com/alperu/soundsuite/commit/1880d1564203ac171e9eac7ba05c9e3ca6a8bee7))
* **search:** phase-2 — provenance to the UI, table markdown in synthesis, breadcrumbs, Meta View links ([2d35013](https://github.com/alperu/soundsuite/commit/2d3501338817cb3e4898b0b40590039d536d8312))
* **search:** phase-3 — figure chunks, structure-hint routing, MCP parity ([0f388d7](https://github.com/alperu/soundsuite/commit/0f388d74f54ac989c5dcfe95bd5bb3bbb66ca211))
* **vectors:** Meta View tool — docparse structure inspector ([eb9de9a](https://github.com/alperu/soundsuite/commit/eb9de9ac2e660ac3e39719d5726cae23abae5b84))
* **vectors:** pageview-{n} URI segment for the page image viewer ([2d3c8ac](https://github.com/alperu/soundsuite/commit/2d3c8ac8afe9c521071ea31280462668b200a3ae))
* **vectors:** sortable table headers in tableview ([00061da](https://github.com/alperu/soundsuite/commit/00061da176ccd32d922dc654c7d6c259360c0cd7))
* **vectors:** URL scheme /vectors/{tool}/{filter}/{chunkSelection} ([d2831d3](https://github.com/alperu/soundsuite/commit/d2831d309431ad1341580523fbd9c06deb0d8c71))


### Bug Fixes

* **docparse:** centered captions no longer shatter double-spaced body paragraphs ([5201421](https://github.com/alperu/soundsuite/commit/5201421d3779874f211320ab82d996b19bf5a583))
* **docparse:** clear-index wipes persisted structure rows ([11f4362](https://github.com/alperu/soundsuite/commit/11f436279d99b9794294fae31197c3764cd0db62))
* **docparse:** detect singleton first-line-indent paragraph breaks (tesseract model) ([7f05841](https://github.com/alperu/soundsuite/commit/7f05841c7ccc7ec74bd624bdaa3b52c8c0a1b3f4))
* **docparse:** FULL transcript carve-out — RR pages produce zero blocks ([a6f3eaf](https://github.com/alperu/soundsuite/commit/a6f3eaf8be0c41fc736c0b852e15dea52d9875fd))
* **docparse:** heading absorption + wrapped-heading merge on double-spaced pages ([c12c477](https://github.com/alperu/soundsuite/commit/c12c4770397c3222b859ba48f4969cab9ab1ceff))
* **docparse:** merge ALL-CAPS heading wraps (tightly gated) ([a3c85b0](https://github.com/alperu/soundsuite/commit/a3c85b08db0e17f0c52f2877f7a061cb7d30acaf))
* **docparse:** reflow figure OCR into ink bands when logical lines disagree with visual lines ([16ba1b4](https://github.com/alperu/soundsuite/commit/16ba1b4b490c89602543008f656042c2750dbacb))
* **ingestion:** RR split-brain routing + measured paragraph grouping ([6f20ef3](https://github.com/alperu/soundsuite/commit/6f20ef3f093cafb31f41441933e714db1f2f3ae8))
* **metaview:** figure OCR text always superimposed on the image, not hover-revealed ([05ff2a9](https://github.com/alperu/soundsuite/commit/05ff2a9a0b22b9651e2871bfc260b75aaa67035f))
* **metaview:** persist page dimensions with structure; overlay no longer needs a live PDF probe ([e142254](https://github.com/alperu/soundsuite/commit/e142254ac45826a7320f596611db1cfc9efc853d))
* **ocr:** generic quality gate for all observed garbage classes ([04e43b4](https://github.com/alperu/soundsuite/commit/04e43b4bc80b92be70ef854197cd35ac81c52422))
* **ocr:** reject degenerate repetition-loop OCR output before indexing ([c81d0cb](https://github.com/alperu/soundsuite/commit/c81d0cb58b34e53024e0285c20063b33103b9a67))
* **ocr:** wire pipeline.ocrConcurrency into exhibit extraction (Phase 1 of [#5](https://github.com/alperu/soundsuite/issues/5)) ([7eb9dd7](https://github.com/alperu/soundsuite/commit/7eb9dd78c176b259633470f4df641417b9ee06bd))
* **ocr:** wire pipeline.ocrConcurrency into exhibit extraction with clamping ([7e2cef3](https://github.com/alperu/soundsuite/commit/7e2cef3caf6270ef55aa87ee47aea598150c656b))
* **render:** pdftoppm-first page rendering; repair pdfjs fallback ([15c4355](https://github.com/alperu/soundsuite/commit/15c4355245a8c1719abe87f647ea7d337100d5c0))
* **search:** phase-0 recall/robustness fixes from the metadata research audit ([2c7fc7e](https://github.com/alperu/soundsuite/commit/2c7fc7ef98371ea4e9d176bd58376b572b9ad33a))
* **vectors:** Meta View empty-state distinguishes carve-out from pre-docparse ([34dc4f4](https://github.com/alperu/soundsuite/commit/34dc4f4f0b36f4c7584e3f4bd2cbbd16d0b78c42))

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
