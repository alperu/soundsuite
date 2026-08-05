# PLAN: `ss-docparse` — structured document parsing service

**Date:** 2026-08-05
**Parents:** `research-ocr-structured-parsing-roadmap.md` (Phase 3), `TODO-paddleocr-vl-and-readiness-score.md` (§A.7 deferred item)
**Status:** draft for review — no code yet

## 0. What and why (one paragraph)

A new CUDA-only fleet role running the **official PaddleOCR two-stage pipeline** (PP-DocLayoutV3
layout detection + PaddleOCR-VL-1.6 recognition) via the official vLLM-based genai server. Unlike
the current Ollama GGUF path (single model, plain text out), it emits **ordered, typed blocks** —
heading / paragraph / table / footnote / seal / signature / page furniture — with bounding boxes and
reading order. That structure feeds a table-aware chunker and chunk provenance ("Page 14, ¶ 23,
under 'Motion to Compel'"), which is the retrieval payoff. The Ollama `OCR:` path stays as the fast
default and universal fallback; ss-docparse is an all-or-nothing document-level switch (§4).

**Naming decision:** `ss-docparse` (not `ss-ocr-full`) — the service does layout + reading order +
tables, and a second role named "ocr" would confuse operators about which is which.

## 1. Where it's operated (UI surfaces)

| Surface | What appears | Work needed |
|---|---|---|
| `/admin/ocr` | New **"Structured Document Parsing"** card: enable toggle (binary, §4), per-attempt timeout, status line (reachable? version?), backfill hint when flipping on | New card in `OCRProviderPanel` (`admin-dashboard.tsx`) |
| `/admin/roleassign` | `ss-docparse` chip, assignable only to CUDA/linux hosts (`docker-vllm` runtime) | None — driven by mode catalog |
| `/admin/roletypes` | New **`ss-docparse`** row in the Mode Types reference table (label "Document Parsing", availableOn `linux`, default model = the pinned genai-server image/model, "configured at ↗" chip → `/admin/ocr`) | None in the component — the page is read-only over `GET /api/admin/mode-catalog`; the row appears when the catalog entry is added (`mode-catalog.ts` + `mode-catalog-server.ts`, §2). Verify the 4-mode assumption in `admin-role-types.tsx`'s doc comment/fallback doesn't hardcode a count |
| `/admin/gpu` | Container row per sidecar (status, image, VRAM, actions) | None — driven by registry |

NOT on `/admin/embedding` — that page is vector-generation only.

## 2. Fleet / sidecar wiring

**⚠ Registry landmine (memory: project_sidecar_registry_overwrite):** every ContainerDef change must
go in BOTH `sideCar/src/lib/state.ts` (`defaultRegistry`) AND `sideCar/src/lib/mode-templates.ts` —
the master's config push wholesale-replaces `state.registry[role]` from mode-templates.

- **Role key:** `docparse` (mode name `ss-docparse`)
- **Runtime:** `docker-vllm` only (CUDA). Like `reranker`, it is `gpuOnly: true` and excluded from
  Mac hosts (`availableOn: ['linux']`; Docker Desktop Mac has no GPU passthrough).
- **Image:** the official PaddleOCR genai vLLM server image (pin a digest at implementation time;
  verify it bundles PP-DocLayoutV3 + PaddleOCR-VL-1.6 weights or mounts a model volume).
- **Port:** `8101` (8099 = reranker, 8100 = **rlm** — taken, per `sideCar/src/lib/state.ts`; add to
  `MODE_PORTS`). Port-collision check against BOTH the master `MODE_PORTS` map and the sidecar
  `defaultRegistry` is part of step 1's review checklist.
- **VRAM:** ~4000 MB planning figure (0.9B recognizer + layout model + vLLM overhead) — measure and
  correct during implementation.
- **Idle policy:** same idle-timer semantics as reranker (`docker stop` on idle, configurable
  timeout in `/admin/gpu`).
- **Master side — full role-assignment chain** (the catalog is typed, so this is an explicit
  checklist, not one entry; mirror `ss-reranker` at every step):
  1. `src/lib/gpu/mode-catalog.ts`: add `'ss-docparse'` to the `ModeName` union **and**
     `ALL_MODES` (this is what `isModeName()` — the assignment API's validator — accepts),
     plus `MODE_METADATA` (`availableOn: ['linux']`, label "Document Parsing") and
     `STATIC_FALLBACK_MODEL` (pinned genai-server model id) and `MODE_PORTS` (`8101`).
  2. `mode-catalog-server.ts`: default-model resolution (reads the `/admin/ocr` docparse config)
     — no Mac stripping needed (never available there).
  3. `src/lib/db/role-registry.ts` / push path: `ss-docparse` must flow through `enabledModes` +
     `modelOverrides` to the sidecar on assignment save (verify nothing filters to a hardcoded
     4-mode list).
  4. `admin-role-assignments.tsx`: runtime options for the chip — `docker-vllm` only (extend
     `availableRuntimesForOs` handling if it special-cases roles).
  5. `fleet-router.ts`: `docparse` role + `resolveEndpoint('docparse')` with the reranker's
     gpuOnly routing guard (no silent CPU fallback).
  Once (1) lands, the role is visible on `/admin/roletypes` and assignable on `/admin/roleassign`;
  (3)–(5) are what make an assignment actually take effect on the sidecar and route requests.
- **Health/version check:** extend the pattern from `/api/admin/gpu-fleet/ocr-version` — probe the
  server's health endpoint; surface a fleet-panel badge when unreachable or version-mismatched.

## 3. Master engine client

New `src/lib/ingestion/docparse-engine.ts`:

```ts
export interface DocparseBlock {
  type: 'heading' | 'paragraph' | 'table' | 'footnote' | 'seal' | 'signature'
      | 'page_header' | 'page_footer' | 'page_number' | 'figure' | 'unknown';
  text: string;              // exact transcription; tables: normalized cell text
  html?: string;             // tables only — structured table markup from the pipeline
  bbox: [number, number, number, number] | null;   // page-relative, if provided
  order: number;             // reading-order index within the page
  confidence?: number;
}
export interface DocparsePageResult {
  pageNumber: number;
  blocks: DocparseBlock[];
  markdown?: string;         // pipeline's page markdown, kept for debugging/exports
}
```

- One request per page image (same preprocessed buffers the OCR path already produces).
- Resolves its host via `resolveEndpoint('docparse')`; per-attempt timeout from a new
  `pipeline.docparseTimeoutMs` (default 120_000 — the two-stage pipeline is slower than bare OCR),
  retries ×2 with jitter, **timeout-vs-host-error distinguished in logs** (same as `OllamaOCREngine`).
- API shape: the genai server's own endpoint (verify at implementation: dedicated parse route vs
  OpenAI-compatible). Isolate the HTTP shape entirely inside this module.
- **Failure = fallback, never data loss:** on unreachable/timeout/parse-error, the page falls back
  to the current Ollama OCR path and the document is marked `docparseFallbackCount++` (surfaced like
  `ocrFailedCount`). Ingestion never fails because ss-docparse is down.

## 3.1 What the current pipeline actually stores (audit 2026-08-05 — why full docparse is needed)

Verified against the live code before committing to the binary policy:

- **Layout is destroyed at PDF extraction.** `pdf-parser.ts:324` flattens pdfjs text items with
  `.map(item => item.str).join(' ')` — coordinates, font size/name, and even line breaks are
  discarded before any downstream code runs. There is no layout to preserve; docparse is not
  duplicating anything.
- **Heading detection exists only as regex heuristics on that flattened text.**
  `legal-text-splitter.ts:50-63` matches `SECTION n` / `ARTICLE ...` / `WHEREAS` / all-caps lines /
  numbered paragraphs. Fragile by construction (all-caps party names false-positive; multi-column
  text arrives scrambled), but it drives split boundaries today.
- **Nothing structural is persisted.** The splitter's `structureType` never reaches the stored
  `ChunkMetadata`, the vector store, or search (zero references in `vector-store.ts` /
  `embedding-provider.ts`). No heading path, nothing queryable, nothing citable.
- **One behavior worth keeping:** the splitter **prepends the current section heading to child
  chunk text** (`legal-text-splitter.ts:414`) as embedding context. The StructuredChunker (§6)
  must retain this — with docparse's real headings instead of regex guesses — since removing the
  prefix would regress embedding quality on long sections. Added to the §6.1 inventory.

Conclusion: docparse does not overlap any stored feature; it replaces regex guessing with real
structure and makes it persistent for the first time.

## 4. Routing policy — binary, document-level (decision 2026-08-05)

Config `pipeline.docparseEnabled`: `false` | `true`. **No per-page heuristic.**

An earlier draft proposed a `selective` per-page policy (route scanned/table-heavy pages, skip
born-digital). Rejected on review: the pre-parse signals (density, poppler, filing type) can detect
*scanned*, but cannot detect *has structure worth parsing* without running the layout model —
chicken-and-egg — and worse, headings live mostly in born-digital pleadings, which selective would
have skipped. That yields heading-path provenance only on the documents least likely to have clean
headings, and search results that behave differently per document with no visible reason.
**When enabled, every document goes through docparse; when disabled, none do.** Consistent chunks,
consistent citations, one mental model.

The single carve-out (not routing — feature protection): reporter's records / transcripts
(line-numbered 1–25 pages) always keep the existing line-aware path — see §6.1's line-number
hazard. They are already perfectly structured; docparse adds nothing there.

Latency consequence (see §4.1): with `docparseEnabled`, born-digital pages that today skip OCR
entirely also pay a parse. This is the price of corpus-wide structure. Mitigations: vLLM batching,
a dedicated docparse concurrency knob, and the expectation that flipping it on is paired with an
overnight backfill re-ingest, not done casually mid-day. Optimization noted for v2 (open question
§10): born-digital pages could derive blocks from the PDF text layer + layout-only detection,
skipping VL recognition — same structured output, fraction of the cost.

## 4.1 Latency impact vs the current pipeline

Will this slow ingestion down? **For routed pages, yes — that is the trade; the policy exists to
contain it.** Baseline numbers measured on this fleet 2026-08-05 (TITAN RTX host, warm model):

| Page kind | Current path | Current cost/page | With ss-docparse | Expected cost/page |
| --- | --- | --- | --- | --- |
| Text-rich (born-digital) | pdftext extraction, **no OCR** | ~ms | routed when enabled (binary policy, §4) | est. 1–5 s (layout + recognition; v2 optimization: text-layer blocks at ~ms) |
| Scanned page | Ollama PaddleOCR-VL `OCR:` | **4–6 s** measured (2.2 s full-page render case) | layout + per-region recognition via vLLM | est. **3–10 s** (TBD — measure in step 1) |
| Exhibit image | Ollama `OCR:` | **1–3.7 s** measured | same or routed | est. 2–8 s |
| Transcript (RR) | line-aware text path | ~ms | **excluded by policy (§6.1)** | ~ms |

Context: the old MiniCPM-V baseline was 30–40 s median per OCR call, so even docparse's worst
estimate stays well under what ingestion tolerated a month ago.

Why the docparse estimate is a range, not a number: the two-stage pipeline runs layout detection
(PP-DocLayoutV3, typically sub-second) then recognition **per detected region** — a dense page with
30 blocks costs more than one full-page `OCR:` call, but vLLM continuous batching amortizes
regions, and the 0.9 B recognizer is small. Measuring real pages is the first deliverable of
step 1; the table gets corrected then.

What bounds the total-wall-clock impact:

1. **Binary policy (§4)** — the switch is corpus-wide, so the cost is paid deliberately (flip +
   overnight backfill), not page-by-page unpredictably; transcripts never route regardless.
2. **Parallelism** — the vLLM server batches concurrent requests natively; docparse gets its own
   concurrency knob rather than sharing `ocrConcurrency`.
3. **Fallback (§3)** — a slow/down docparse degrades to today's fast path, never blocks ingestion.
4. **`all` policy is opt-in** — turning every page into a GPU parse is a deliberate operator
   choice for a quality-first backfill (e.g. re-ingesting a critical case overnight), not the
   default.

Rule of thumb for operator expectations: a 100-page scanned filing that today OCRs in ~8–10 min at
concurrency 1 (or ~2 min at 5) should be planned at roughly 1.5–2× that under docparse until
step 1 produces measured numbers.

## 5. Structure persistence (additive, nullable — safe migration)

- `PageCache`: add nullable `structuredJson` (serialized `DocparsePageResult`), `parseMethod`
  (`'pdftext' | 'ollama-ocr' | 'docparse'`).
- LanceDB chunk rows: add `blocks` back-reference metadata (block order indexes + heading path),
  following the existing `annotations` column precedent.
- `Document`: `docparsePageCount Int?`, `docparseFallbackCount Int?`.
- Migration rules (memory: prisma-migrate danger): back up `prisma/data/sound-suite.db` first;
  `prisma migrate deploy` ONLY; never `migrate dev`. Ask the operator before running.

## 6. Table-aware chunker (the payoff — must land with the service)

New `ITextChunker` implementation `StructuredChunker` used when a page has `structuredJson`:

1. Separator tiers: heading > table boundary > paragraph > sentence > bare `\n`.
2. Tables ≤ chunk limit stay **atomic** (one chunk, `html` preserved in metadata). Larger tables
   split on row boundaries **with header-row repetition** per fragment.
3. Page furniture (header/footer/page_number) excluded from chunk text, kept in metadata.
4. Footnotes chunk with their anchor paragraph when they fit, else as trailing chunks tagged
   `footnote`.
5. **Chunk provenance:** every chunk records `{ pageNumber, headingPath: string[], blockOrders:
   number[], bbox? }` → search hits become citable and deep-linkable.
6. Pages without structure keep the existing `LegalTextSplitter` unchanged.

### 6.1 Backward compatibility — existing chunk metadata MUST NOT regress

The pipeline already embeds rich per-chunk metadata that downstream features depend on. The
StructuredChunker emits the **full existing `ChunkMetadata`** (`text-chunker.ts:18-37`) — the new
provenance (`headingPath`, `blockOrders`, `bbox`) is **additive fields**, never a replacement
schema. Inventory of what must survive, with consumers:

| Existing field(s) | Set by | Consumed by |
| --- | --- | --- |
| `pageNumber`, `chunkIndex` | all chunkers | search results, citations, reindex-pages vector clearing |
| `isExhibit`, `exhibitPath` | chunkers (exhibit chunks) | exhibit retrieval (`retrieve_exhibit`), UI |
| `filingId`, `filingType`, `volumeNumber`, `caseNumber`, `documentType` | pipeline | filing-aware search filters, citations |
| **`startLine` / `endLine`** (transcript lines 1–25, RR docs) | `line-number-detector.ts` → `ingestion-pipeline.ts:856` | MCP citation builders (`query-case-knowledge.ts:542`, `scan-for-pattern.ts:305`) → "page X, lines Y–Z" transcript citations |
| `annotations` (JSON `PageAnnotation[]`) | annotation overlap pass | annotation-aware retrieval/UI |
| **Heading-prefix in chunk text** (section heading prepended to child chunks) | `legal-text-splitter.ts:414` | embedding quality on long sections — StructuredChunker must keep this behavior, sourced from docparse's real headings (§3.1) |

**The transcript line-number hazard (biggest regression risk):** §6 item 3 excludes "page
furniture" from chunk text — but a layout model will plausibly classify reporter's-record margin
line numbers (1–25) as furniture. Stripping them breaks BOTH the stored `startLine`/`endLine`
stamping (detector runs on page text) AND the MCP tools' query-time fallback re-detection (which
reads numbers from the chunk text itself). Mitigations, in order of preference:

1. **v1: route transcripts around docparse.** The transcript carve-out (§4) explicitly excludes
   documents whose `documentType`/`filingType` indicates a reporter's record — they are already
   line-structured and gain the least from layout analysis. Cheapest and zero-risk.
2. If transcripts are ever routed through docparse: run `line-number-detector` on the **raw page
   text before furniture exclusion**, stamp `startLine`/`endLine` from block bbox → line mapping,
   and keep the margin numbers in chunk text for the fallback path.
3. Never exclude a block as furniture when the page matches the transcript line-number pattern.

**Acceptance test for step 5:** an RR volume ingested with docparse enabled must produce chunks
whose `startLine`/`endLine` and MCP citations are byte-identical to the current path.

## 7. Config keys (Config table, `pipeline.*`)

| Key | Default | Meaning |
| --- | --- | --- |
| `docparseEnabled` | `false` | master switch (UI toggle) |
| `docparseTimeoutMs` | `120000` | per-attempt request timeout |

## 8. Testing

- Engine unit tests: mock server — block parsing, timeout/fallback, retry jitter (mirror
  `ollama-ocr-engine.test.ts`).
- Chunker unit tests: atomic table, split-with-header-repeat, heading provenance, furniture
  exclusion, footnote attachment.
- Pipeline integration test: structured page → chunks carry provenance; docparse-down → fallback
  path produces today's output byte-identically.
- Manual A/B (extends the §A.7 item): the three probe filings (scanned / table-heavy / handwritten)
  through `off` vs `all`; diff chunk quality and search-hit citability.

## 9. Rollout order & estimates

| Step | Scope | Est. |
| --- | --- | --- |
| 1 | Sidecar ContainerDef (both files!) + master catalog/ports/router + fleet panel visibility | 1–2 d |
| 2 | `docparse-engine.ts` + config keys + `/admin/ocr` card | 1–2 d |
| 3 | Prisma migration (operator-approved, backed up) + persistence plumbing | 1 d |
| 4 | `StructuredChunker` + provenance metadata | 2–3 d |
| 5 | Binary switch + transcript carve-out + fallback accounting + tests | 1–2 d |
| 6 | A/B validation on probe filings; flip `docparseEnabled` default per results | 0.5 d |

Prerequisite per roadmap: Phase 1 quality gates (garbage detection) should be landed first — they
protect whichever parse path runs.

## 10. Open questions (resolve before step 1)

1. Exact image + API contract of the official genai vLLM server (endpoint shape, batch support,
   whether bboxes are emitted through this server).
2. Real VRAM footprint alongside the reranker on shared hosts (TITAN RTX 24 GB budget math).
3. Whether exhibit extraction should also consume docparse blocks (seal/figure blocks → exhibit
   candidates) in v1, or stay on the current poppler path until v2.
4. v2 cost optimization for born-digital pages: derive blocks from the PDF text layer + layout-only
   detection (skip VL recognition) — same structured output at ~ms instead of seconds. Decide
   whether it ships with v1 if the `all`-pages latency proves painful in step 6's measurement.
