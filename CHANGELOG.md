# Changelog

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
