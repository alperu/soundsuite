# Retrieval & RLM — Engineering Task Proposals

**Status:** Proposed · **Last updated:** 2026-06-08

These are concrete, code-grounded engineering proposals derived from the verdict and the
"ideas to evaluate later" list in [`../rag-hybrid-retrieval-and-rlm-analysis.md`](../rag-hybrid-retrieval-and-rlm-analysis.md).
That document is an *analysis* (nothing changes because of it); these files translate its §8
forward-looking ideas into actionable tasks that cite real files and symbols in this repo.

Each task is a single self-contained markdown file with: Problem/opportunity · What we already have
(file:line) · Proposed approach · Implementation steps · Risks/open questions · How to measure
success · References. Nothing here is implemented — these are proposals for review.

| # | Title | Effort | Priority | One-line summary |
|---|-------|--------|----------|------------------|
| [01](./01-adaptive-rag-router.md) | Adaptive-RAG complexity router | M | High | Auto-pick no-retrieval / single-shot hybrid / deep-search / RLM per query, so simple lookups skip RLM's cost+latency (today `useRlm`/`deepSearchMode` are manual UI toggles). |
| [02](./02-graph-aware-retrieval-haystack.md) | Graph-aware retrieval over the existing Haystack/Xeto graph | M | High | Reuse our authoritative legal knowledge graph + `prisma-traverse` for multi-hop *retrieval/expansion* (connections between parties/motions/filings), not just `case_id` filtering. NOT Microsoft GraphRAG — no entity extraction. |
| [03](./03-colpali-visual-retrieval.md) | ColPali/ColQwen3 layout-aware visual retrieval | L | Medium | Late-interaction (multi-vector MaxSim) retrieval over exhibit/scanned page-images, where text-only chunking loses stamps/tables/signatures. Feeds the existing `rerank()` stage. |
| [04](./04-learned-fusion-weighting.md) | Learned / query-dependent fusion weighting | M | Medium | Replace the fixed RRF `k=60` and the arbitrary `SOFT_BOOST = 1.2` with tunable / query-dependent / learned weighting. Closes the one real gap vs. the blog's ideal. |
| [05](./05-reranker-resilience-and-chunk-overlap.md) | Reranker resilience + chunk-overlap tuning | S | Medium | Two small, well-scoped hardening items: a graceful first-stage-order path for the 90s reranker timeout on a degraded fleet, and revisiting the 50-token chunk overlap for legal boilerplate. |
| [06](./06-mcp-two-profiles.md) | MCP two profiles: `local` evidence engine + `routed` LLM router | L | High | Split the MCP surface into a fail-closed local-only evidence engine and a preset-driven cloud router, with async research/report jobs, PresetV2, provenance logging, and a profile-aware bridge. **Implemented 2026-09-03.** |
| [14](./14-alternation-recall-and-speaker-attribution.md) | `scan_for_pattern` alternation recall, honest exhaustion, speaker attribution | M | High | An alternation of transcript boilerplate returns zero (short branches dropped → lone stopword survivor → `\|` barred from full-scan rescue); a cursor-free final page can still carry a cap warning, so no negative finding is defensible; and speaker attribution is retrievable from chunk text despite a null `speakers` column. |
| [15](./15-branch-coverage-generalisation.md) | Generalise branch coverage beyond alternations | S | Critical | Task 14 applied its own rule only where a `\|` was present, so `[Cc]ould not do` (keywords reduce to the stopword `not`) still returns a cursor-free zero while the same phrase de-tokenised finds a real hit. Also corrects task 14's overstated completeness guarantee: escalation was gated on a *capped* pool, and an empty pool is never capped. |
| [22](./22-rerank-observability.md) | Rerank is unobservable, unverifiable, and skipped for RLM evidence | S+M | P0 | The cross-encoder *does* run, but `rerankScore` equals `score` by construction (the first-stage score is overwritten in place, then boosted), the flag gating it is a pool size read *before* the call, there is no `rerank` phase, and RLM-round evidence bypasses rerank entirely. |
| [23](./23-corpus-status-and-denominators.md) | `corpus_status()` and naming the denominator | S | P0 | **Implemented 2026-09-08 (items 1–4, 7).** Measured: 864 documents, 96 indexed (11.1%), 768 never ingested; per-case coverage 2.3%–44.4%. Items 5–6 (wiring the denominator into scan prose) remain open. |
| [24](./24-completeness-object.md) | Machine-readable `completeness`, instead of warning prose | S+M | P0 | Callers regex-match English to decide exhaustiveness. `scan_for_pattern` already computes every fact (5 vars need hoisting); `query_case_knowledge` computes none. `exhaustiveOverIndex` + `corpusCoverage` — two claims, two fields, no threshold. |
| [25](./25-rlm-notes-live-trace.md) | `rlmNotes` is empty during the run, not on the result | XS+S | P1 | v12 had it backwards: the result carries the notes; `research_status` is empty for the whole run because they are replayed after the await. Report jobs never call `rlmNote` at all. |
| [26](./26-batched-chunk-context.md) | Batched `get_chunk_context({ chunkIds })` | M | P1 | 4–6 store probes per call, not 3; no liftable function exists, so batching needs an extraction refactor first. Build the batched form first, single-target as a thin caller. |
| [27](./27-subquery-grounding-gate.md) | Ground sub-queries before deep retrieval | S | P1 | ~50 s of a 140 s job spent retrieving invented subjects. A gate at `gather-evidence.ts:427` reuses fuse+rerank signals already paid for — no extra retrieval. |
| [28](./28-server-side-speaker-attribution.md) | Server-side `speaker` + `speakerBasis` | M | P1 | Turns task 14's five-call caller-side ritual into a field. `speakerBasis` distinguishes a text-derived guess from a structurally-backfilled fact. |
| [29](./29-progress-notifications.md) | Progress notifications — extend the bridge that exists | S–M | P2 | v12's premise was wrong: `notifications/progress` is already implemented in `scripts/mcp-bridge/bridge.mjs` with `seq` resumption. What is missing is the cursor on events and three silent mutations. |
| [30](./30-mcp-parity-and-fleet-visibility.md) | Parameter parity + read-only fleet tools | S | P2 | `searchMode`/`recordStatus` exist only on `query_case_knowledge`. `multiPass` is a *synthesis* switch, not retrieval — v12's inference corrected. No MCP surface for the fleet. |
| [31](./31-result-size-economy.md) | `fields` projection and count-only summary | S | P2 | The 60 KB cap is a **client** display limit, not a server ceiling — the docs say otherwise and should be corrected first. Pagination cost is the real justification. |
| [34](./34-ingestion-dry-run-and-retry.md) | Ingestion dry-run, and a retry that is actually bounded | S–M | P0 | Blocks 35. `ssPromoteDiscovered` **does not exist** — it is prose cited as real in two documents. No attempt counter exists anywhere: filed failures loop unboundedly across restarts, unfiled ones are terminal. The OCR branch pauses the whole process for 30 s per requeue. |
| [35](./35-bulk-promotion.md) | Bulk promotion of the 768 un-ingested documents | M | P0 | The only task that changes what the system can answer. `filingId` is not required to parse, so this is a status update, not 768 filing decisions. Waves by case, smallest first — compute the order from `corpus_status` at run time and re-read between waves; it reordered within hours of being written down. Needs 21 **and** 34. |
| [36](./36-reparse-pre-structure-documents.md) | Re-parse the 74 documents predating structured parsing | M | P1 | 74 of 96 indexed documents have no `parserVersion`; only 22 (2.5% of the corpus) have structure. "Run the backfill" was the wrong frame — three quarters of the indexed slice has nothing to back-fill *from*. |
| [37](./37-generated-prose-denominators.md) | Denominators in generated prose | M | P1 | `gaps` and report prose are LLM-authored at runtime, so no string sweep can see them — and they are the sentences most likely to be pasted into a filing. Needs 24. Inject the denominator **and** validate the output; context is a suggestion, the check is the guarantee. |
| [38](./38-interactive-embedding-budget.md) | The interactive embedding path has no interactive budget | S–M | P1 | Rerank has an interactive timeout that degrades to first-stage order with a user-facing warning; embedding has one constant for every caller, 3 attempts and exponential backoff — a computed worst case of ~370 s against rerank's 30 s. Diagnosed, not proven: nothing observed reached any timeout. Instrument (item 6) before tuning. Amends 30 with probe-don't-relay, the role→port map, and UNREPORTED ≠ down. |
| [33](./33-full-scan-denominator-gap.md) | The denominator attached to the weaker proof, not the stronger one | XS | P0 | **Implemented 2026-09-08.** Task 23 items 5–6 shipped the denominator on the uncapped `fts+regex` proof, but all three `full-scan` paths — the ones that read every chunk and sound strongest — carried no numbers. The more confident statement was the less qualified one. |
| [32](./32-draft-semantics-reconciliation.md) | Two meanings of "draft" in one payload | XS–S | P2 | `Draft: Motion` beside `containsDraft: false`. Trace both derivations before renaming — a clearer name on a wrong value is worse than a confusing name on a right one. |

## Tasks 22–32 — provenance

Tasks 22–32 derive from [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md),
which was written from the caller's side without reading the source. Four of its premises were then
found wrong (`rlmNotes` inverted, `notifications/progress` already implemented, the 60 KB cap on the
client side, `rerankPoolSize` never reaching a response). **Task 23 was built and verified end to end;
22, 24 and 25 are written against source read during the same session; 26–32 are marked
*diagnosed, not verified* in their own headers** — treat their designs as proposals whose premises
still need reproducing, not as settled specifications.

## On "are we already doing GraphRAG?"

The answer is **no, not in the Microsoft-GraphRAG sense** — but we already have most of the
substrate. See [task 02](./02-graph-aware-retrieval-haystack.md) for the full framing. Short version:
our `src/lib/haystack/` is **Project Haystack / Xeto** (a typed tagging ontology), and the graph it
backs is *authoritative* (built from parsed filings at ingestion, not LLM-extracted). Today that
graph is used at query time only to compute **filters** (`case_id IN (...)`), not for multi-hop
retrieval or community summarization.
