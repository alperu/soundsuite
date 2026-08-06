# OCR & Structured Parsing Roadmap — Quality-Gate + Baidu OCR Research Synthesis

**Date:** 2026-08-05
**Companion docs:** `research-baidu-ocr-models.md`
**Constraint:** no Python in the app stack. Everything below is TypeScript + HTTP-served models.

---

## 0. Correction to in-repo docs (important)

The pipeline described in `src/lib/ingestion/README.md`, `INGESTION_PIPELINE.md`, and the root `CLAUDE.md` (pdfjs-dist + tesseract.js) is **stale**. What actually runs:

- **Text extraction:** `@d0paminedriven/pdfdown` (NAPI native), with pdfjs-dist as whole-document and per-page fallback (`pdf-parser.ts:231`, ~246, 266 — the per-page fallback comment explicitly names *tables* as what pdfdown fails on).
- **OCR:** PaddleOCR v4 ONNX via `@gutenye/ocr-node` in a forked worker (`workers/ocr-worker.js`), **or** a remote Ollama vision model (default `richardyoung/olmocr2:7b-q8`), selected by `config.ocrProvider`.
- The README's "confidence < 60% returns empty text" is dead tesseract documentation — the live acceptance gate is `trimmedText.length >= 100` (`ingestion-pipeline.ts:1422`). Confidence is recorded in `PageCache` but never gates anything.

These doc files should be updated as part of any work here.

## 1. Current-state gaps (from the pipeline audit)

15 stages (`src/lib/pipeline-stages.ts:7-23`), Redis progress, `IngestCheckpoint` resume, per-page `PageCache` upserts. The gaps that this research targets:

1. **No table extraction at all.** The entire table-aware surface is one sentence in the Ollama OCR prompt (`ollama-ocr-engine.ts:22`: "For tables use | delimiters"), and only in Ollama mode. PaddleOCR-ONNX mode joins detection boxes with `\n` — **all bounding-box/layout info is discarded** at `ocr-worker.js:29-34`.
2. **Tables don't survive chunking anyway.** `LangChainTextChunker` has `HARD_MAX_CHUNK_CHARS = 1000` and no table-aware separator (`langchain-text-chunker.ts:19-52`); a wide pipe table is cut on a row boundary with no header repetition — headerless fragments. Fixing extraction without the chunker yields little retrieval benefit.
3. **Vector-only pages are silently skipped.** OCR fires only if the page has an embedded raster image (`pageHasImages()` at `ingestion-pipeline.ts:1327`; single best embedded image via `getOcrCandidateImage()` at :1338). A scanned-to-vector or vector-drawn table page gets nothing. `renderPageToImage()` exists (`pdf-parser.ts:377`) but is unused on this path.
4. **Quality is invisible.** Status is binary INDEXED/ERROR; garbage OCR reaches INDEXED and silently poisons search. Per-page `source: 'extract'|'ocr'` and confidence exist in `PageCache` but are discarded before chunking.
5. **No near-duplicate detection** beyond exact SHA-256.
6. **No embedding-space validation** on LanceDB despite three swappable providers.

Existing seams that make this tractable:

- `GpuRole` already includes `'ocr'` (`fleet-router.ts:152`), GPU-only scheduled, endpoint-resolved. **A new Ollama-served OCR model is a config change only**: set `pipeline.ocrOllamaModel` on `/admin/ocr` (`mode-catalog.ts:9-13`), pull the model on the host. A non-Ollama runtime needs a `ContainerDef` in `sideCar/src/lib/mode-templates.ts` + a `ROLE_PORTS` entry (`fleet-router.ts:824`).
- `IngestionPipeline` constructor accepts `ocrWorkerFactory?: () => IOCREngine` (`ingestion-pipeline.ts:133`) — new backends are injectable.
- `ITextChunker` (`text-chunker.ts:79`) — a structure-aware chunker is a drop-in.
- `vector-store.ts:268` — non-destructive `addColumns` schema evolution; `annotations` (JSON string column) is the precedent for structured metadata.

The blocking mismatch: **`IOCREngine` is an image → flat-text seam.** `OCRResult = {text, confidence}` (`ocr-engine.ts:22-33`) has no field for structured output, and the pipeline hands it a cropped embedded image, never a rendered page.

## 2. What we're adopting from each source

| Source | Adopt | How |
|---|---|---|
| Quality-gate research | Readiness score, warning codes, per-block confidence, chunk provenance, MinHash dedup, versioned OCR policy, embedding-space enforcement, table_data schema | **Native TS implementation** |
| PaddleOCR-VL-1.6 | Structured page parsing (tables, handwriting, layout, seals) on Mac/Metal | llama-server GGUF (~1 GB), OpenAI-compatible `/v1`, Apache-2.0 |
| Unlimited-OCR | Multi-page single-pass long-document parsing on CUDA | Official `vllm/vllm-openai:unlimited-ocr` image, MIT. NOT via Ollama/llama.cpp (R-SWA PR #24975 unmerged → loses flat-KV-cache) |
| Available today | `deepseek-ocr` / `glm-ocr` in Ollama + DMR catalogs | Config-only swap of `pipeline.ocrOllamaModel` |

## 3. Phased plan

### Phase 1 — Quality visibility (no new models, ~2–3 days)

Pure-TS wins over signals we already compute; each independently shippable.

1. **Readiness score + bands** (`readinessScore` on `Document`, HIGH/OK/RISKY/POOR in dashboard, configurable review threshold). Baselines + penalty table in `TODO-paddleocr-vl-and-readiness-score.md` §B.
2. **Warning codes**: `OCR_REQUIRED`, `ENCRYPTED_PDF`, `MISSING_PAGE`, `LOW_TEXT_DENSITY`, `GLYPH_ARTIFACTS` (CID-garbling detector — plausible-but-wrong text), `NEAR_EMPTY_OUTPUT`. Store on `Document` (JSON), surface with recommended actions.
3. **Extraction-confidence propagation**: carry `PageCache.source` (`extract`/`ocr`) into chunk metadata → LanceDB (`addColumns`), return it from `query_case_knowledge`, optional high-confidence-only search filter.
4. **Embedding-space enforcement**: stamp model/dimension/metric into LanceDB table metadata, validate on open, hard-fail "rebuild required" on mismatch (~30 lines).
5. **Versioned OCR-selection policy**: formalize the existing `ocrThreshold` heuristic into a recorded, versioned decision (`ocrPolicyVersion` + reason per page in `PageCache`/checkpoint) for auditability.

### Phase 2 — Better OCR models (config + small code, ~1 week)

1. **Refactor the engine seam first** (prereq, small):
   - Extract a single `createOcrEngine(config)` factory — the provider `if/else` is duplicated verbatim in `worker-init.ts:44-68` and `app/api/documents/[id]/reindex-pages/route.ts:106-115` (live footgun).
   - Widen `OCRResult` with optional fields: `markdown?: string`, `blocks?: LayoutBlock[]` (keeps both existing engines compiling).
   - For document-parser backends: bypass `pageHasImages()` and switch from `getOcrCandidateImage()` to `renderPageToImage()` so every low-density page gets a full rendered page, fixing the vector-page blind spot (§1.3).
   - Revisit the `length >= 100` acceptance gate — markdown scaffolding inflates length; gate on stripped text.
2. **PaddleOCR-VL-1.6 backend** (Mac/Metal): new `ocrProvider` value speaking OpenAI-compatible `/v1/chat/completions` to llama-server; a `ContainerDef` (`runtime: 'host'` or llama-server container) + `ROLE_PORTS` entry. TS post-processor assembles markdown + `blocks[]` from bbox-tagged output.
3. **Unlimited-OCR backend** (CUDA sidecars): `ContainerDef` for `vllm/vllm-openai:unlimited-ocr`; client sends base64 pages with `vllm_xargs: {ngram_size: 35, window_size: 128}`; use `Multi page parsing.` for long filings. ~30-line `<|det|>` post-processor; `image`-category bboxes double as **exhibit crop candidates**.
4. **Stopgap available immediately**: trial `deepseek-ocr` from the Ollama/DMR catalog against the current olmOCR default — zero code.

### Phase 3 — Structured retrieval (the payoff, ~1–2 weeks)

Must land with or after Phase 2 — structure is destroyed at chunk time otherwise.

1. **Table-aware chunker** (`ITextChunker` drop-in): keep tables atomic where ≤ limit; split on row boundaries **with header-row repetition** otherwise; add table/heading separator tiers above bare `\n`.
2. **Persist structure**: nullable structured column on `PageCache`; `blocks`/layout JSON column on LanceDB rows (follow the `annotations` precedent).
3. **Chunk provenance**: nearest heading (section/numbered paragraph) + block back-references in chunk metadata → citable, deep-linkable search hits.
4. **`table_data` schema** with `ExtractionMethod` provenance and provenance-excluding checksums (rows/columns/spans/header-detection captured from the VLM output alongside the Markdown rendering).
5. **MinHash+LSH near-duplicate detection** at ingestion (5-word shingles, 64 permutations, ~150 lines TS): skip-or-link near-duplicate documents, and de-duplicate top-k retrieval.

## 4. Decision summary

- **No external ingestion-pipeline dependency** — the quality-gate ideas are implemented natively in TS.
- **PaddleOCR-VL-1.6** is the first model integration (official GGUF + llama-server, Apache-2.0, handwriting + tables, ~1 GB).
- **Unlimited-OCR** is the CUDA long-document option via its official vLLM image (MIT); never via llama.cpp until R-SWA lands upstream.
- **Phase 1 costs nothing in models and fixes the scariest failure mode** (silently indexed garbage) — do it first regardless of model decisions.
- Update the stale ingestion docs (`src/lib/ingestion/README.md`, `INGESTION_PIPELINE.md`, root `CLAUDE.md` pipeline description) while in there.
