# Changelog

## [1.3.6](https://github.com/alperu/soundsuite/compare/v1.4.1...v1.3.6) (2026-10-16)


### Features

* **admin:** log-off button moved to left nav sidebar below Docs link (single instance, session-aware) ([f1bfde8](https://github.com/alperu/soundsuite/commit/f1bfde88dcd7193e1947445ede7e28063cd382cf))
* **admin:** move log-off button below docs panel; hide sidebar on standalone login page ([7529a9f](https://github.com/alperu/soundsuite/commit/7529a9fa5f3e6a01e1c0d39bd2c1d103ad9e8533))
* **admin:** OCR Performance card on /admin/ocr — concurrency + timeout sliders ([02865ad](https://github.com/alperu/soundsuite/commit/02865ad5c4b792dd79e995e2ab0f993cb561dd5b))
* **admin:** OCR Performance sliders on /admin/ocr ([d033193](https://github.com/alperu/soundsuite/commit/d033193fe4530ba65b7d45532b4f9a5710873cee))
* **admin:** show logged-in username above log-off button in sidebar ([2fedb2f](https://github.com/alperu/soundsuite/commit/2fedb2fb216d0e7e4254092b6d35f5be0c024d70))
* **admin:** Users, Sessions, and Cloudflare tabs with cookie-based admin login ([8a0e05d](https://github.com/alperu/soundsuite/commit/8a0e05ded19104d3c3a21bccd9c06ab19732331a))
* **ai:** add Claude Fable 5 to model picker ([435903d](https://github.com/alperu/soundsuite/commit/435903dda54b8940e8ad8faa8480d36b0dd2f757))
* **ai:** add Claude Fable 5.1 to the Anthropic model catalog with adaptive-effort support ([0e907b7](https://github.com/alperu/soundsuite/commit/0e907b71ff1b195cb40b14b59fa8a4490ea31706))
* **ai:** per-model capability registry + provider refresh ([57278b0](https://github.com/alperu/soundsuite/commit/57278b016e9811f53caffe6a892bc95524cae256))
* **ai:** prompt caching — cacheTtl setting (default 1h) + deep-search shared-prefix breakpoint ([9df1f04](https://github.com/alperu/soundsuite/commit/9df1f0491cb05dc3aedfd4b00857cf85c52d23cb))
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
* **gpu:** add ss-code-embedding role (jina-code-embeddings-1.5B) across admin + sidecar ([31e3927](https://github.com/alperu/soundsuite/commit/31e3927fb43f91a5ea2951d000382a7213af3d3d))
* **gpu:** admin-configurable per-model GPU weight (--gpu-memory-utilization) ([de4a543](https://github.com/alperu/soundsuite/commit/de4a543ede0286ca168c10e8240ecad317378203))
* **gpu:** raise shipped reranker gpu-memory-utilization default 0.6 → 0.85 ([dd9ff36](https://github.com/alperu/soundsuite/commit/dd9ff368328db6ec9cda59e6a10815c068d158b2))
* **mcp:** close v5 residual gaps; wire the outline model to admin config ([931ae89](https://github.com/alperu/soundsuite/commit/931ae891ccd85d2d1f2f5990a42893996f3fd377))
* **mcp:** guard the API surface, add discovery tools, make scan a real regex ([7d148b3](https://github.com/alperu/soundsuite/commit/7d148b398898722760594814407c0661843ef113))
* **mcp:** make local evidence citable and bounded (v4 fixes) ([c4cee6f](https://github.com/alperu/soundsuite/commit/c4cee6fa83eaea466d333cdfbe46e9a86e9cba94))
* **mcp:** split the MCP surface into local (evidence) and routed (LLM router) profiles ([59a9236](https://github.com/alperu/soundsuite/commit/59a92365fa04f093184bdb50bb4a32b3f390ac07))
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
* **rerank:** operator-tunable interactive timeout + enforce-eager toggle ([41261b0](https://github.com/alperu/soundsuite/commit/41261b070c656f56897c514a9b1fc8033f814c63))
* **rerank:** phase-timing diagnostics to pinpoint interactive-timeout degrades ([7277fb7](https://github.com/alperu/soundsuite/commit/7277fb70b550ef9a17dd12748fed65b9b2dd95e3))
* **rerank:** pool-size setting + explicit reranker restart on container-arg change ([ed64f34](https://github.com/alperu/soundsuite/commit/ed64f34e5ec31779ec25229f9b727d315d89fc77))
* **rr:** block-derived line stamping behind comparison logging ([1cafb52](https://github.com/alperu/soundsuite/commit/1cafb52a2fc3b9b54fb8be0fae8c901687d73ff8))
* **rr:** schema deltas + structureOnly twin flags (PLAN-rr-structure items 4-5) ([a0bd298](https://github.com/alperu/soundsuite/commit/a0bd29806bddb6d71ad72bc4d3d9c6174bb1f276))
* **rr:** transcript structure with line numbers, chunk text byte-identical ([2aba21f](https://github.com/alperu/soundsuite/commit/2aba21feaafd3f874d17fda79c676c361356c648))
* **scope+test:** containment fan router, test-infra archaeology paid down ([ad8a340](https://github.com/alperu/soundsuite/commit/ad8a3407ab3e41f132f24440e711dae678e0293b))
* **scope:** complete linking UX — badges, menus, picker, pairing workbench ([2898798](https://github.com/alperu/soundsuite/commit/2898798384d5087ae10f4bc60daa8ac3294f4657))
* **scope:** dedicated linkTo lane — target-first drags work on occupied hubs ([79ecb17](https://github.com/alperu/soundsuite/commit/79ecb1703681b414a3550ba2b85f237b162e3335))
* **scope:** full motion names + every writable slot visible when empty ([fde91a6](https://github.com/alperu/soundsuite/commit/fde91a623cba6309094cdafb958b888bdea9544d))
* **scope:** Haystack Block View — visual scope editor, entity linking, and search-scope override ([dbadca4](https://github.com/alperu/soundsuite/commit/dbadca4b27da18c39e2580c617b672fcbe0512ed))
* **scope:** orderRef edges render + hub gains a safe press row ([319f8bf](https://github.com/alperu/soundsuite/commit/319f8bf8d0c12a58fe3f44c002b80aa743ea2a7e))
* **scope:** selection-persistent edges, attachment→order links, Haystack Management nav ([e1ca5fd](https://github.com/alperu/soundsuite/commit/e1ca5fdebb03d6e73668a1cbbc2e23803ae4d512))
* **scope:** zoom-compensated slot labels + layout polish ([4affaaf](https://github.com/alperu/soundsuite/commit/4affaaf6a975177eb2b823bbd5de7e54bca27eda))
* **search:** always-visible delete on selected preset with confirm dialog ([47e09db](https://github.com/alperu/soundsuite/commit/47e09db3a1fd6c8dbd0c70c2e55469d9f145e85f))
* **search:** draft-record guard + v3 MCP follow-up fixes ([0cb5dd8](https://github.com/alperu/soundsuite/commit/0cb5dd8f4ce28d78fa1842664485a34128d5f0da))
* **search:** phase-1 structure metadata — columns, RR speakers, boosts, grounding ([1880d15](https://github.com/alperu/soundsuite/commit/1880d1564203ac171e9eac7ba05c9e3ca6a8bee7))
* **search:** phase-2 — provenance to the UI, table markdown in synthesis, breadcrumbs, Meta View links ([2d35013](https://github.com/alperu/soundsuite/commit/2d3501338817cb3e4898b0b40590039d536d8312))
* **search:** phase-3 — figure chunks, structure-hint routing, MCP parity ([0f388d7](https://github.com/alperu/soundsuite/commit/0f388d74f54ac989c5dcfe95bd5bb3bbb66ca211))
* **ui:** add SoundSuite brand logo to sidebar + app favicon ([c3fb40e](https://github.com/alperu/soundsuite/commit/c3fb40ed5467993667caff2927dff9a97c2f86df))
* **vectors:** Meta View tool — docparse structure inspector ([eb9de9a](https://github.com/alperu/soundsuite/commit/eb9de9ac2e660ac3e39719d5726cae23abae5b84))
* **vectors:** pageview-{n} URI segment for the page image viewer ([2d3c8ac](https://github.com/alperu/soundsuite/commit/2d3c8ac8afe9c521071ea31280462668b200a3ae))
* **vectors:** sortable table headers in tableview ([00061da](https://github.com/alperu/soundsuite/commit/00061da176ccd32d922dc654c7d6c259360c0cd7))
* **vectors:** URL scheme /vectors/{tool}/{filter}/{chunkSelection} ([d2831d3](https://github.com/alperu/soundsuite/commit/d2831d309431ad1341580523fbd9c06deb0d8c71))


### Bug Fixes

* a fully-stale fleet reported a role unavailable instead of unknown ([4fa2f5b](https://github.com/alperu/soundsuite/commit/4fa2f5bd40619218159a85635f82b8e5561362e2))
* **chat-history:** stop source preview &lt;/details&gt; from corrupting loaded turns ([1fcbb0a](https://github.com/alperu/soundsuite/commit/1fcbb0a8c85bf984d7b484aea631fe7dca9d528b))
* **ci:** legacy-peer-deps so npm ci passes in CI + Docker ([72366f6](https://github.com/alperu/soundsuite/commit/72366f6594f2e30d5a738686624971d0415ec7d3))
* **code-embedding:** pull jina model via hf.co GGUF ref (was unpullable bare name) ([fbd6ba8](https://github.com/alperu/soundsuite/commit/fbd6ba89bd259fdb2b748f0bb1982271dc0503f9))
* **deep-search:** only honor and/or operators inside {{ }} chips ([9b15196](https://github.com/alperu/soundsuite/commit/9b151960f462b494218f5643b84c39431a786849))
* **deep-search:** prevent blank Fable 5 synthesis at high effort ([6c9428d](https://github.com/alperu/soundsuite/commit/6c9428dc78f0bc62acd26f5a79f77155540660aa))
* **deep-search:** RLM down should skip, not fail the whole search ([026c448](https://github.com/alperu/soundsuite/commit/026c44877458a9b99627f71732f90c350cb21fd1))
* **docparse:** centered captions no longer shatter double-spaced body paragraphs ([5201421](https://github.com/alperu/soundsuite/commit/5201421d3779874f211320ab82d996b19bf5a583))
* **docparse:** clear-index wipes persisted structure rows ([11f4362](https://github.com/alperu/soundsuite/commit/11f436279d99b9794294fae31197c3764cd0db62))
* **docparse:** detect singleton first-line-indent paragraph breaks (tesseract model) ([7f05841](https://github.com/alperu/soundsuite/commit/7f05841c7ccc7ec74bd624bdaa3b52c8c0a1b3f4))
* **docparse:** FULL transcript carve-out — RR pages produce zero blocks ([a6f3eaf](https://github.com/alperu/soundsuite/commit/a6f3eaf8be0c41fc736c0b852e15dea52d9875fd))
* **docparse:** heading absorption + wrapped-heading merge on double-spaced pages ([c12c477](https://github.com/alperu/soundsuite/commit/c12c4770397c3222b859ba48f4969cab9ab1ceff))
* **docparse:** merge ALL-CAPS heading wraps (tightly gated) ([a3c85b0](https://github.com/alperu/soundsuite/commit/a3c85b08db0e17f0c52f2877f7a061cb7d30acaf))
* **docparse:** reflow figure OCR into ink bands when logical lines disagree with visual lines ([16ba1b4](https://github.com/alperu/soundsuite/commit/16ba1b4b490c89602543008f656042c2750dbacb))
* **ingestion:** RR split-brain routing + measured paragraph grouping ([6f20ef3](https://github.com/alperu/soundsuite/commit/6f20ef3f093cafb31f41441933e714db1f2f3ae8))
* **mcp:** assertCasesExist fails loudly when it cannot validate ([e581586](https://github.com/alperu/soundsuite/commit/e5815863887fd6591c33a19e288c5a9ac3fe80c7))
* **mcp:** citation parity under caseIds ([af0986d](https://github.com/alperu/soundsuite/commit/af0986db1350fa9e6fe74520ec76e7f99c8a863c))
* **mcp:** multi-case scoping, parameter typing, and no ORM leaks on the search tools ([d838531](https://github.com/alperu/soundsuite/commit/d8385310e33df1a6fb94f3bf877015ef899ab4ac))
* **mcp:** scan_for_pattern recall soundness — branch coverage and honest exhaustion ([1ee0a4f](https://github.com/alperu/soundsuite/commit/1ee0a4ff3c243331cd787eaedc465f7ae7223e62))
* **metaview:** figure OCR text always superimposed on the image, not hover-revealed ([05ff2a9](https://github.com/alperu/soundsuite/commit/05ff2a9a0b22b9651e2871bfc260b75aaa67035f))
* **metaview:** persist page dimensions with structure; overlay no longer needs a live PDF probe ([e142254](https://github.com/alperu/soundsuite/commit/e142254ac45826a7320f596611db1cfc9efc853d))
* **ocr:** generic quality gate for all observed garbage classes ([04e43b4](https://github.com/alperu/soundsuite/commit/04e43b4bc80b92be70ef854197cd35ac81c52422))
* **ocr:** reject degenerate repetition-loop OCR output before indexing ([c81d0cb](https://github.com/alperu/soundsuite/commit/c81d0cb58b34e53024e0285c20063b33103b9a67))
* **ocr:** wire pipeline.ocrConcurrency into exhibit extraction (Phase 1 of [#5](https://github.com/alperu/soundsuite/issues/5)) ([7eb9dd7](https://github.com/alperu/soundsuite/commit/7eb9dd78c176b259633470f4df641417b9ee06bd))
* **ocr:** wire pipeline.ocrConcurrency into exhibit extraction with clamping ([7e2cef3](https://github.com/alperu/soundsuite/commit/7e2cef3caf6270ef55aa87ee47aea598150c656b))
* **render:** pdftoppm-first page rendering; repair pdfjs fallback ([15c4355](https://github.com/alperu/soundsuite/commit/15c4355245a8c1719abe87f647ea7d337100d5c0))
* **rerank:** always push reranker gpu-memory-utilization default (0.85) ([1dfc0d9](https://github.com/alperu/soundsuite/commit/1dfc0d9f6f490852db89357090df931730e503a9))
* **rerank:** raise reranker --max-num-batched-tokens to 32768 ([268f7aa](https://github.com/alperu/soundsuite/commit/268f7aac86c7dc99e1352a9b788a50991baf888b))
* **rlm:** never 400 on long input; preserve the user's pasted text ([e8807a3](https://github.com/alperu/soundsuite/commit/e8807a3d25586aac2cc7c631697033da9e610824))
* **scope:** edge-to-circle alignment corpus-wide, show-all includes containment, pin-until-hide links ([02d7e0f](https://github.com/alperu/soundsuite/commit/02d7e0f2500cd27397d95c369f99dddecebb5f5c))
* **scope:** multi-ref hub press opens the per-link menu instead of grabbing blind ([b622f4f](https://github.com/alperu/soundsuite/commit/b622f4fcd539f0e6efe4101a7823bb08b6dd5bcf))
* **scope:** orders expose a writable motionRef input on both surfaces ([581f880](https://github.com/alperu/soundsuite/commit/581f8804416f5401c32a365e4ab8ba479966bdd0))
* **scope:** real clicks select blocks, ref edges route through channels, panel opens the entity's own row ([7caacf6](https://github.com/alperu/soundsuite/commit/7caacf62356a44d7fc4ebf609aa053206cbd0f0e))
* **scope:** records kinds offer only caseRef; held orderRef renders; aimed drags never write a different fact ([69f5619](https://github.com/alperu/soundsuite/commit/69f5619c7129f8be984f7a1901e8c6cee9d2c3e8))
* **scope:** slot rows arm link drags + atomic entity-row materialisation ([8cfa408](https://github.com/alperu/soundsuite/commit/8cfa408a3b5a4003f188dda94b0e56ea301a42e6))
* **scope:** whole block is a drop target — drag-to-link no longer requires hitting a 7px socket ([06d0338](https://github.com/alperu/soundsuite/commit/06d0338e109a7a35bbaa3491465a5afe97f4b0a9))
* **search:** /search/history/[chatId] route + stop deep follow-ups clobbering history ([7f03d58](https://github.com/alperu/soundsuite/commit/7f03d58ff26e8cfee943b3a17bee0f21faa388d1))
* **search:** harden RLM paths — AI-mode fallback + cap RLM stream (audit P1/P2) ([0a1db00](https://github.com/alperu/soundsuite/commit/0a1db006e5e60bd42cd74a57e27a1523828e579b))
* **search:** history sessions keep source provenance across save/reload ([95f8ce5](https://github.com/alperu/soundsuite/commit/95f8ce5425ca837884a07770a499320216a1b55d))
* **search:** hydration mismatch on composer textarea maxHeight ([7344c22](https://github.com/alperu/soundsuite/commit/7344c22aa33881a0dca2eb4c6c551fc5ac426f41))
* **search:** module-scoped chat session id survives Deep/Compare remounts ([9ab4a37](https://github.com/alperu/soundsuite/commit/9ab4a3787fcbcae52e77508911a2441818e64471))
* **search:** only run Axon boolean validation inside {{ }} chips ([1decabd](https://github.com/alperu/soundsuite/commit/1decabdd56f28e230ae227624aa0799fcb17e95b))
* **search:** persist per-turn deletion in chat history ([03e4725](https://github.com/alperu/soundsuite/commit/03e4725ca1cfd86ed448d8e3de5d4c5d4204a145))
* **search:** phase-0 recall/robustness fixes from the metadata research audit ([2c7fc7e](https://github.com/alperu/soundsuite/commit/2c7fc7ef98371ea4e9d176bd58376b572b9ad33a))
* sync package-lock.json to 1.0.1 ([7b1e055](https://github.com/alperu/soundsuite/commit/7b1e055f4bc01154065fb5e4b9bf0fa1a46618a1))
* **vectors:** Meta View empty-state distinguishes carve-out from pre-docparse ([34dc4f4](https://github.com/alperu/soundsuite/commit/34dc4f4f0b36f4c7584e3f4bd2cbbd16d0b78c42))


### Performance Improvements

* **mcp:** cap query_case_knowledge rerank pool (115s→~5s), add phase timing + dev HMR registry rebuild; add MCP improvements report ([8fc8da6](https://github.com/alperu/soundsuite/commit/8fc8da6272dbf48e40a14e115b9b880f42b46bae))


### Miscellaneous Chores

* pin next release ([8708d99](https://github.com/alperu/soundsuite/commit/8708d99b88397789b120402da30ca5b12edfe1a2))
* pin next release ([54b70a6](https://github.com/alperu/soundsuite/commit/54b70a60360b3b90d0ea0f7a321e20ce3e515475))
* pin next release ([422c62e](https://github.com/alperu/soundsuite/commit/422c62ec7b4a51d7961b929ecd253bdcd5172552))
* pin next release ([4ccac47](https://github.com/alperu/soundsuite/commit/4ccac4732496bd1a0b68f65740851a854256351d))
* sync release-please manifest to v1.3.1, pin next release ([df528b9](https://github.com/alperu/soundsuite/commit/df528b9d0ee37c210cfece5a1d67f0bb830c0d34))

## [1.4.1](https://github.com/alperu/soundsuite/compare/v1.4.0...v1.4.1) (2026-09-19)

> Requested as "Sound Suite 1.4.01". Semantic versioning has no leading zeros, so the tag and
> `package.json` carry **1.4.1**; read "1.4.01" and "1.4.1" as the same release.

### Release Notes

Two days, 23 commits, 123 files, +9,742 / −851 lines, 11 new test suites. Three themes:
**profiles** (several isolated data sets in one install, switchable from the sidebar and over
MCP), **Haystack vendor ops + model-driven ETL** (the case graph and the ingestion pipeline are
now callable by an AI client through a catalogued, gated op surface, with a dashboard page that
lets a model read a folder of PDFs and propose the whole mapping), and **resilience of the
service layer** under profile switches and dev-server reloads.

#### Profiles — one active data set per install (`docs/tasks/54-profiles.md`)

* **Layout.** `data/<name>/` holds a profile: `profile.json`, `sound-suite.db`, `lancedb/`,
  `chat/`, `chat-attachments/`, `ocr-captures/`, `backups/`. `data/profiles.json` names the
  active one. Profiles are **discovered from disk**, never listed in code; `SS_PROFILE` forces one
  at boot, `SS_DATA_ROOT` relocates `data/`.
* **Runtime.** `prisma` and the Kysely `db` are proxies over per-profile clients — 119 importers
  unchanged. `lancedbPath()` replaces every `process.env.LANCEDB_PATH || './data/lancedb'`
  (27 sites). Chat history, attachments, OCR captures and backups resolve per profile at call time.
* **Switching** is process-wide (design A, chosen over per-session state for debuggability):
  registry → stop watcher / parsing workers / scanner daemon → release DB clients → rebuild the
  MCP tool registry → restart. Measured 45 ms – 3 s. In-flight parses are re-queued by the
  boot-time orphan recovery.
* **Sidebar.** A profile dropdown above **Cases** (name · case count), "＋ New profile…" inline
  with "copy settings from", and an **edit button** opening a panel: display name, description,
  folder rename (non-active only), delete (non-active only, never the last one). Delete **moves**
  the folder to `data/.trash/<name>-<timestamp>`; nothing empties it automatically
  (`docs/tasks/55-profile-crud.md`).
* **API.** `GET/POST /api/profiles`, `GET/POST /api/profiles/active`,
  `GET/PATCH/DELETE /api/profiles/[name]`. New profiles clone the **schema** of the active
  profile's SQLite (`sqlite_master` DDL + the `_prisma_migrations` ledger, no rows) — the Prisma
  CLI is unreliable on an empty file (`db push` trips on the JSON `@default("{}")` DDL,
  `migrate deploy` on a data-dependent migration).
* **MCP.** `profile_list` (every profile, active flag, cases in each) and `profile_use(name)`.
  **Every** tool result carries `profile`; `/api/mcp/execute` and the `:3001` server also send
  `x-ss-profile`. An optional `expectProfile` param on **any** tool refuses the call with
  `PROFILE_MISMATCH` (HTTP 409) when it names a profile other than the active one — a guard, not
  a router.
* **Machine state is shared** (`docs/tasks/56-system-db.md`). `HostRoleAssignment`,
  `HostProvisioning`, `SidecarCommand`, `AdminUser`, `McpSession`, `ModelDownload` route to
  `data/system.db`, created on first use and seeded from every profile with `INSERT OR IGNORE`.
  Redis is **not** partitioned: cached case keys are UUID-rooted and never collide, and fleet
  state must be global. `/api/health` now leads with a `profile` block (active, legacy flag,
  available profiles, sqlite / lancedb / system paths).
* **Scripts.** `scripts/profiles-migrate.mjs <name>` moves the pre-profiles layout into
  `data/<name>/` by rename (refuses while :3000/:3001 listen or the WAL is non-empty) and repoints
  `.env`. `scripts/manage.mjs` and `prisma.config.ts` resolve the active profile
  (`--profile <name>` / `SS_PROFILE`), so `db:migrate`, `db:backup`, `db:restore` target it.
* **Legacy mode.** A checkout with no profile directory runs exactly as before under the
  synthetic name `legacy`; the dropdown is disabled and says to run the migration.

#### Haystack vendor ops and the MCP bridge (`docs/tasks/53-haystack-etl-ops-and-auto-ingest.md`)

Implements phases 1–3 of `docs/PLAN-haystack-mcp-agentic-etl.md`.

* **One catalogue, three surfaces.** `src/lib/haystack/ops/catalogue.ts` describes each `ss*` op
  (params, doc, exposure). The Haystack HTTP `ops` grid now emits `params`, `doc` and
  `ssExposure` per row; the HTTP adapter coerces query/body params against it; the MCP bridge
  (`mcp/tools/haystack-ops.ts`) generates one tool per op, named as the op.
* **Read ops** (both MCP profiles): `ssScopeGraph` (summary per case or one case drilled to
  filings, with a real `unconnected` count), `ssWorklist` (filings whose **defining** link is
  empty, with the deterministic suggestion and its reasons — the same selection the browser
  workbench uses, lifted to `src/lib/scope/worklist.ts`), `ssFolderSurvey` (disk vs database by
  path then SHA-256: known / moved / new / orphaned / ignored, nested-case detection),
  `ssIngestStatus` (per-case status counts; `DISCOVERED` named separately from `INDEXED`),
  `ssReadCase` (meta = whole-case truth, rows = documents).
* **Write ops** (routed only, `dryRun` defaults to true): `ssCaseEnsure`,
  `ssPromoteDiscovered`, `ssRequeueErrored`, `ssAutoIngestApply`. A `dryRun: false` from MCP or
  the bearer-key HTTP API is refused unless the server runs with **`SS_HAYSTACK_WRITE=1`**; the
  same-origin dashboard proxy is exempt — the person at the keyboard is the review gate. The
  standard `commit` op is deliberately **not** bridged.
* Every `ss*` grid's meta carries `profile`.

#### Model-driven auto-ingestion (Haystack ETL)

* **`ssAutoIngestPlan(path)`** walks a folder, reads the **first two pages** of each PDF, and asks
  OpenRouter (default `deepseek/deepseek-v4.1-flash`) for: the case identity from the caption
  (cause number, court, parties, evidence quote; disagreement between sampled files is
  **reported, never resolved**); per file **what / who / when** — canonical filing type, clean
  title, which side filed it and who signed, `filedOn` from the **clerk's file stamp only**
  (`stampEvidence` verbatim; a signature date is never a filing date), `signedOn` separately,
  confidence, evidence, and which motion a response / reply / order answers; a target subfolder
  per file. The regex detector runs beside the model so disagreements are visible. Writes nothing.
* **`ssAutoIngestApply(plan)`** never re-runs the model. Idempotent steps: Case found by path or
  created via `commitEntity` (with `ssProvenance`); optional move into per-kind subfolders with the
  Document row re-pathed **before** the watcher sees the rename; Filing found by slug or created;
  entity row through `ensure-filing` (never a raw create); `filedOn` / `signedOn` as real spec
  tags and `filedBy` / `author` / `stampEvidence` under one namespaced `ssEtl` tag; Document
  attached by hash and `DISCOVERED → QUEUED`; `respondingTo` / `replyingTo` / `resolves` /
  `motionRef` links only where the target resolved in this run.
* **Pages.** `/haystack-management` is the rete block view on its Editor tab (what the nav entry
  always reached); `/haystack-management/etl` is the ETL panel (path → plan → editable review
  table → dry run → armed apply); `/haystack-management/ops` lists cases with real unconnected
  counts and the live op catalogue. Nav gained **Haystack ETL** under **Haystack Management**,
  same typography and icon column as every other entry.
* **Skill.** `skills/soundsuite-etl/SKILL.md` — the ETL procedure for Claude Desktop: survey,
  plan, review honestly, apply twice, ingest, work the judgment queue, stop conditions, privacy.

#### Case management

* Three columns — **Cases | Filings | content** — with two draggable splitters. Widths and the
  **last case / filing selection** persist in IndexedDB (`caseManagement.layout`,
  `caseManagement.lastSelection`); opening bare `/case-management` restores the last selection
  when that case still exists. The old `localStorage` sidebar width is read once as a fallback.

#### Service layer

* **Survives dev HMR and profile switches.** `worker-init` state and the `ServicesManager`
  singleton live on `globalThis`; the file watcher is **always registered** (starts chokidar on
  the first `addPath`, so a fresh profile discovers its first case); `/api/health` self-heals by
  kicking the one start path when nothing is registered.
* **RLM sandbox failover** (`stream-rlm`): a network failure or 5xx on one sandbox host now
  excludes it and re-resolves the next healthy host instead of skipping RLM for the whole run;
  4xx (409 master identity, 400, 413) still does not fail over.

#### Documentation, specs, tooling

* `docs/SPEC-saas-hosted-multi-tenant.md` revised: **OCR on the customer's OpenRouter key**
  (§2.5, prerequisites P9–P11), a **shared `ss-rlm-sandbox` pool** warm for every tenant's data
  calls (§3.6, Phase 2b), the profiles note (§1.2); totals ~48 → ~60 days.
* `docs/PLAN-haystack-mcp-agentic-etl.md` status updated; tasks 53–56 written.
* `CLAUDE.md` split into a lean per-session file, `AGENTS.md` and path-scoped rules
  (`.claude/rules/`: sidecar release, testing, marketing website); marketing deploy landmines
  recorded; terse-output rule added.
* `ast-grep` project config (`sgconfig.yml`, `.ast-grep/rules`) with custom Fantom / Axon /
  Xeto / trio tree-sitter languages.
* Sidecar **2.4.15** — two internal network references removed from published text; no code path
  change.

#### Upgrade notes

1. Stop the dashboard, then `node scripts/profiles-migrate.mjs <name> --display "<Name>"`
   (`--dry-run` first). It renames `prisma/data/sound-suite.db`, `data/lancedb`, `data/chat`,
   `data/chat-attachments`, `data/ocr-captures` into `data/<name>/` and rewrites `.env`.
   Without it the install runs in legacy mode, unchanged.
2. `data/system.db` appears on first use; nothing to do.
3. Agent writes through the Haystack ops need `SS_HAYSTACK_WRITE=1` on the server. Dashboard
   applies do not.
4. `LANCEDB_PATH`, `DATABASE_URL` in `.env` are now fallbacks for shell scripts only; the running
   app follows `data/profiles.json`.

#### Known issues

* `src/services/__tests__/file-watcher.test.ts` fails 9/9 before and after this release
  (constructs a bare `PrismaClient()` without the Prisma 7 driver adapter).
* Five pre-existing `tsc` errors (`case-management/[caseNumber]/page.tsx`, extended-client
  assignability in `worker-init.ts` / `get-tool-registry.ts`) are unchanged.
* `Config` is per profile by design but also carries machine-ish keys (Ollama host, OpenRouter
  key, worker counts); they are copied at profile creation and drift afterwards.
* Background parsing runs only for the active profile.

### Features

* **profiles:** one active data set per install, sidebar switcher, MCP `profile_list` / `profile_use`, `expectProfile` guard, profile stamp on every result ([efe20d6](https://github.com/alperu/soundsuite/commit/efe20d69))
* **profiles:** edit / rename / delete from the sidebar; `PATCH` / `DELETE /api/profiles/[name]` ([8e93755](https://github.com/alperu/soundsuite/commit/8e937552))
* **profiles:** machine state in shared `data/system.db`; Redis no longer profile-prefixed ([799612f](https://github.com/alperu/soundsuite/commit/799612f2))
* **haystack:** vendor op catalogue, HTTP adapter, MCP bridge, model-driven auto-ingestion, lifted worklist, Haystack Management + ETL pages, ETL skill ([21e2ecd](https://github.com/alperu/soundsuite/commit/21e2ecd9))
* **haystack:** Management restores the rete block view; catalogue moves to `/haystack-management/ops` ([f638763](https://github.com/alperu/soundsuite/commit/f6387631))
* **case-management:** three columns with two splitters; widths and last selection in IndexedDB ([d4c18b7](https://github.com/alperu/soundsuite/commit/d4c18b75))
* **health:** report the active profile first ([6727565](https://github.com/alperu/soundsuite/commit/6727565b))
* **rlm:** fail over to the next sandbox host instead of ending the run ([35a3be3](https://github.com/alperu/soundsuite/commit/35a3be34))

### Bug Fixes

* services survive dev HMR and profile switches; watcher always registered; `/api/health` self-heals ([411f812](https://github.com/alperu/soundsuite/commit/411f812d))
* nav: Haystack ETL entry aligned with sibling links ([b040aaa](https://github.com/alperu/soundsuite/commit/b040aaa9))

### Documentation

* SaaS spec: OCR on the customer's key, shared sandbox pool, profiles note ([6a59fde](https://github.com/alperu/soundsuite/commit/6a59fdeb))
* CLAUDE.md split into per-session file + AGENTS.md + path-scoped rules; deploy landmines; ast-grep config ([83814b7](https://github.com/alperu/soundsuite/commit/83814b71), [873b267](https://github.com/alperu/soundsuite/commit/873b2677), [feedf13](https://github.com/alperu/soundsuite/commit/feedf13c))
* Sidecar 2.4.15 — remove two internal network references ([42a9f04](https://github.com/alperu/soundsuite/commit/42a9f04b))

## [1.4.0](https://github.com/alperu/soundsuite/compare/v1.3.6...v1.4.0) (2026-09-17)


### Features

* **mcp:** close v5 residual gaps; wire the outline model to admin config ([931ae89](https://github.com/alperu/soundsuite/commit/931ae891ccd85d2d1f2f5990a42893996f3fd377))
* **mcp:** guard the API surface, add discovery tools, make scan a real regex ([7d148b3](https://github.com/alperu/soundsuite/commit/7d148b398898722760594814407c0661843ef113))
* **mcp:** make local evidence citable and bounded (v4 fixes) ([c4cee6f](https://github.com/alperu/soundsuite/commit/c4cee6fa83eaea466d333cdfbe46e9a86e9cba94))
* **mcp:** split the MCP surface into local (evidence) and routed (LLM router) profiles ([59a9236](https://github.com/alperu/soundsuite/commit/59a92365fa04f093184bdb50bb4a32b3f390ac07))
* **search:** draft-record guard + v3 MCP follow-up fixes ([0cb5dd8](https://github.com/alperu/soundsuite/commit/0cb5dd8f4ce28d78fa1842664485a34128d5f0da))


### Bug Fixes

* a fully-stale fleet reported a role unavailable instead of unknown ([4fa2f5b](https://github.com/alperu/soundsuite/commit/4fa2f5bd40619218159a85635f82b8e5561362e2))
* **mcp:** assertCasesExist fails loudly when it cannot validate ([e581586](https://github.com/alperu/soundsuite/commit/e5815863887fd6591c33a19e288c5a9ac3fe80c7))
* **mcp:** citation parity under caseIds ([af0986d](https://github.com/alperu/soundsuite/commit/af0986db1350fa9e6fe74520ec76e7f99c8a863c))
* **mcp:** multi-case scoping, parameter typing, and no ORM leaks on the search tools ([d838531](https://github.com/alperu/soundsuite/commit/d8385310e33df1a6fb94f3bf877015ef899ab4ac))
* **mcp:** scan_for_pattern recall soundness — branch coverage and honest exhaustion ([1ee0a4f](https://github.com/alperu/soundsuite/commit/1ee0a4ff3c243331cd787eaedc465f7ae7223e62))

## [1.3.6](https://github.com/alperu/soundsuite/compare/v1.3.5...v1.3.6) (2026-09-03)


### Features

* **search:** always-visible delete on selected preset with confirm dialog ([47e09db](https://github.com/alperu/soundsuite/commit/47e09db3a1fd6c8dbd0c70c2e55469d9f145e85f))


### Miscellaneous Chores

* pin next release ([8708d99](https://github.com/alperu/soundsuite/commit/8708d99b88397789b120402da30ca5b12edfe1a2))

## [1.3.5](https://github.com/alperu/soundsuite/compare/v1.3.4...v1.3.5) (2026-09-03)


### Features

* **ai:** add Claude Fable 5.1 to the Anthropic model catalog with adaptive-effort support ([0e907b7](https://github.com/alperu/soundsuite/commit/0e907b71ff1b195cb40b14b59fa8a4490ea31706))


### Miscellaneous Chores

* pin next release ([54b70a6](https://github.com/alperu/soundsuite/commit/54b70a60360b3b90d0ea0f7a321e20ce3e515475))

## [1.3.4](https://github.com/alperu/soundsuite/compare/v1.3.3...v1.3.4) (2026-08-31)


### Release Notes

* **Cloudflare Tunnel integration (untested):** the plumbing is in place — an admin Cloudflare tab stores the tunnel domain/credentials (secrets masked), probes cloudflared/metrics/public reachability, and generates a locked-down `config.yml` — but the integration has **not been end-to-end tested against a live tunnel yet**.
* **OAuth for remote MCP (Claude Desktop):** the generated tunnel config exposes only `/api/mcp` and the OAuth discovery path (`/.well-known/oauth-protected-resource`), so Claude Desktop can connect to Sound Suite as a remote MCP server with `MCP_AUTH_MODE=oauth` — no port forwarding, TLS at the Cloudflare edge.


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
