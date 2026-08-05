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
default and universal fallback; ss-docparse is routed selectively.

**Naming decision:** `ss-docparse` (not `ss-ocr-full`) — the service does layout + reading order +
tables, and a second role named "ocr" would confuse operators about which is which.

## 1. Where it's operated (UI surfaces)

| Surface | What appears | Work needed |
|---|---|---|
| `/admin/ocr` | New **"Structured Document Parsing"** card: enable toggle, routing policy (`off` / `selective` / `all`), per-attempt timeout, status line (reachable? version?) | New card in `OCRProviderPanel` (`admin-dashboard.tsx`) |
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

## 4. Routing policy (which documents go through it)

Config `pipeline.docparsePolicy`: `off` (default until proven) | `selective` | `all`.

`selective` heuristic (cheap, from data we already have at ingest time):
- page text density < OCR threshold (scanned) **and** poppler reports images → parse
- filing detector says exhibit-heavy or the page count of detected tables > 0 → parse
- readiness score (Part B work) below a configurable band → parse
- everything else → fast Ollama `OCR:` path

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

## 7. Config keys (Config table, `pipeline.*`)

| Key | Default | Meaning |
| --- | --- | --- |
| `docparseEnabled` | `false` | master switch (UI toggle) |
| `docparsePolicy` | `selective` | routing when enabled |
| `docparseTimeoutMs` | `120000` | per-attempt request timeout |
| `docparseReadinessBand` | `moderate` | selective-routing threshold |

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
| 5 | Selective routing + fallback accounting + tests | 1–2 d |
| 6 | A/B validation on probe filings; flip `docparseEnabled` default per results | 0.5 d |

Prerequisite per roadmap: Phase 1 quality gates (garbage detection) should be landed first — they
protect whichever parse path runs.

## 10. Open questions (resolve before step 1)

1. Exact image + API contract of the official genai vLLM server (endpoint shape, batch support,
   whether bboxes are emitted through this server).
2. Real VRAM footprint alongside the reranker on shared hosts (TITAN RTX 24 GB budget math).
3. Whether exhibit extraction should also consume docparse blocks (seal/figure blocks → exhibit
   candidates) in v1, or stay on the current poppler path until v2.
