# PLAN: Pipeline resume + speed — recover from failures in minutes, not hours

**Date:** 2026-08-07
**Basis:** two design investigations (stage-resume + performance), both grounded in measured
timings from the 2026-08-07 ingest of a 1403-page record (1160 born-digital pages, 518 exhibit
candidates, 357 detected tables, ~6,900–10,400 chunks) that failed at embedding and re-ran in full.
**Status:** design — no code yet.

## 0. The incident, measured

One socket drop during embedding (`terminated` after 72 s on batch 23/138 — the embed call has **no
timeout, no retry, no host exclusion**) killed the document after ~80 min of work. The queue retried
and **re-executed everything**: text extraction, block extraction (1160 pages / 17,462 blocks),
exhibit extraction (~252 OCR sends, again), the structure sweep (~1,190 region-OCR calls, again).
**≈2 hours of GPU/CPU discarded because of one HTTP request.** The 22 embedding batches that had
already succeeded were also thrown away.

## 1. Four findings that reframe the problem

1. **The checkpoint system is write-only.** `loadCheckpoint` (`ingestion-pipeline.ts:241`) has zero
   call sites. Every resume that works today is PageCache-driven (page text/OCR restore) — nothing
   else ever resumes. "Improve checkpointing" actually means "add the read sites."
2. **The OCR cache is discarded at the start of every run.** `CachedOCREngine` keys on
   `${task}:${sha256(buffer)}` and covers both exhibit and structure region OCR — but
   `processDocument` calls `clearCache()` unconditionally (`ingestion-pipeline.ts:620-622`), and the
   cache is memory-only. One persistent SHA-keyed store makes retries nearly free (content hashes
   cannot go stale).
3. **The OCR quality gate is discarding valid text — a live correctness bug.** 224 rejections in the
   run; **192 (86%) were `run-together-text`**, median rejected output 1,023 chars, p90 9,881. Root
   cause: `ocr-quality-gate.ts:164` rejects an entire page if **any single token** is ≥30 chars
   (`tokens.some(...)`) — one URL, email, or concatenated table cell zeroes the whole page. A sampled
   rejection was a correctly-OCR'd affidavit page. Cost: **51 min of GPU producing discarded text**,
   and ~192 pages/regions **silently missing from the search index today**.
4. **Exhibit extraction is already concurrent and GPU-bound** (2 slots saturated, 261% GPU-to-wall) —
   the brief's "make it concurrent" premise was wrong. Its lever is the gate fix (+30% of the stage)
   and possibly image downscaling, not concurrency.

## 2. Prioritized work items (merged from both reports)

| # | Change | Saving (this document class) | Effort |
|---|---|---|---|
| 1 | **Embedding: per-batch retry + backoff + host exclusion + timeout** | ~2 h (kills the duplicate-run failure mode) | 0.5 d |
| 2 | **Quality gate `run-together-text`: `some()` → ratio test** | ~51 min GPU + ~192 recovered text regions (correctness) | 2–3 h |
| 3 | Structure stage: concurrent region OCR (`p-queue` @ `ocrConcurrency`) | 52 → ~18–20 min | 0.5 d |
| 4 | Structure rehydration from persisted `structuredJson` | removes the ~1,000-call sweep on retries | S–M |
| 5 | Persistent SHA-keyed OCR cache (L2 under CachedOCREngine; cache rejections too) | retries/re-ingests nearly free | 1–2 d |
| 6 | Pre-OCR region filters upstream (minPt at call site, area gate, ink-density) | ~5–8 min + fewer wasted renders | 0.5 d |
| 7 | Fleet routing: local in-flight counters + per-stage resolution caching | stability; fixes cross-role blindness | 0.5 d |
| 8 | Exhibit image downscale before OCR (**A/B accuracy first**) | up to ~8 min | 0.5 d + measurement |
| 9 | Concurrent embedding batches (2–3 in flight) | ~6 min (9.7 → ~4 min stage) | 2 h |
| 10 | Region budget + consecutive-rejection early-abort (**only after #2**) | bounds worst case | 2 h |
| 11 | True exhibit resume + per-stage checkpoint fingerprints | least value per cost — deferred | M–L |

Items 1+2 are cheap, independent, and capture the large majority of recoverable time.

## 3. Key design details

### 3.1 Embedding retry (item 1)
- `OllamaEmbeddingProvider.embed` (`ollama-embedding-provider.ts:124-218`): add
  `AbortSignal.timeout` (60–90 s) around `client.embed()` (:174 — currently unbounded); 3 attempts
  with 3/6/12 s backoff (mirror `OllamaOCREngine` constants); on attempt n>1 re-resolve via
  `resolveEndpoint('embedding', { excludeHosts: [failedHosts] })` — **excludeHosts already exists**
  (`fleet-router.ts:889/:903`), the provider just never passes it; clear the failed host's preflight
  cache. Retry must live **inside** the pipeline batch loop (`ingestion-pipeline.ts:2116-2184`) so
  completed batches are kept; in-memory continuation only (no vector persistence). On a batch that
  exhausts retries: skip + `embeddingFailedCount` (pattern: exhibit `ocrFailedCount`).
  Per-batch incremental indexing is deferred (blocked by wholesale `deleteByDocument` at :657).

### 3.2 Quality gate ratio fix (item 2)
- Replace the `some()` quantifier: reject only when run-together tokens hold >~30% of characters (or
  ≥25% of alpha tokens); whitelist URL/email/path-shaped tokens before counting; keep
  `latex-hallucination` (11 firings) and `repetition-loop` (27) unchanged — those look like real
  catches. Optional later: partial-accept of passing lines. Regression fixtures: synthetic
  run-together page vs. legitimate-URL page. After shipping, **re-OCR the affected regions once**
  (item 5's rejection-caching makes this a one-time cost) and rescore.

### 3.3 Structure concurrency + rehydration (items 3–4)
- Concurrency: collect all `{page, block}` escalation candidates document-wide, drive via `p-queue`
  at `ocrConcurrency` (proven pattern: `exhibit-extractor.ts:384-388`). Per-block in-place mutation
  → no ordering hazard. GPU-bound ceiling ~78% already; expect ~2.6×.
- Rehydration: in the pipeline **before** the producer call (~:912), load
  `PageCache.structuredJson` rows gated on `parserVersion === 'hybrid-docparse-1'` + `force` flag;
  set `page.blocks/pageWidth/pageHeight`; pass only unstructured pages to `produceStructuredPages`;
  persist only new pages. **Traps:** blob omits `structureOnly` (infer from `producer === 'rr'`),
  and RR docs need `structureOnly` set **document-wide** (producer sets it on block-less pages too)
  or the RR chunk byte-identity guarantee breaks.

### 3.4 Persistent OCR cache (item 5)
- New table `OcrCache { key(task:sha256) PK, text, confidence, engine, createdAt, lastUsedAt }`;
  `CachedOCREngine` becomes read-through (memory L1, DB L2). Only cache non-empty accepted results
  — plus, after item 2, cache gate-rejections `{accepted:false, reasons}` so re-runs skip known-bad
  regions once re-verified. Retention: LRU sweep + delete on document delete. Store `engine` so an
  OCR-model switch invalidates naturally. Additive migration (`migrate deploy`, backup first).
  Note: crop/preprocess cost (sharp/poppler) is NOT covered — OCR calls dominate, but the floor stays.

### 3.5 Fleet contention (item 7)
- `resolveEndpoint` scores on heartbeat-stale `activeRequests` (~5 s cadence) and is called
  per-request (1,190 resolutions in the structure window) — bursts pile onto one host, and
  embedding can't see OCR pressure on the same GPU. Add module-level in-flight counters
  (increment in resolve, decrement in release), score `reported + localInFlight[role] +
  discounted total`, and cache resolution per stage with re-resolve-on-failure (pairs with 3.1).

## 4. Latent bugs to fix alongside (both are live today)

1. **`OllamaOCREngine` never calls `releaseEndpoint`** — with in-flight counters (item 7) this
   would leak monotonically; it's a routing-accounting bug regardless.
2. **PageCache restore sets `renderFailed: false` unconditionally** (`ingestion-pipeline.ts:1482,
   :1531`) — resumed runs score readiness better than fresh runs of the same file. Persist the flag
   or recompute.
3. Structure counters don't reconcile with observed sends (~490 unexplained attempts) — add a
   per-region outcome counter.

## 5. Verification

- **Item 1:** kill the embedding host mid-stage (or firewall it) on a test document → stage retries
  onto another host, document completes; simulate all-hosts-down → partial index +
  `embeddingFailedCount` surfaced, no full-document failure.
- **Item 2:** fixture pair (run-together page vs. URL-bearing page) in gate tests; then re-OCR a
  known-rejected region and confirm it lands in the index and Meta View.
- **Items 3–5:** re-ingest the same large record; assert structure stage wall-clock, zero region-OCR
  sends on a second run (cache hits), and identical block counts vs. baseline.
- Corpus rescore after item 2's re-OCR pass (readiness v2 backfill, no force needed if chunks change).
