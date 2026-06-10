# Changelog

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
