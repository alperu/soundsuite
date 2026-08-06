# TODO: PaddleOCR-VL-1.6 Adoption + AI Readiness Score

**Date:** 2026-08-05
**Parent report:** `report-ingestion-paddleocr-vl.md`
**Research basis:** two agent investigations — (A) MiniCPM-V (deployed) vs PaddleOCR-VL-1.6, (B) readiness-score change analysis against the working tree at commit `095b646`.

---

# Part A — MiniCPM-V → PaddleOCR-VL-1.6: improvements and differences

## A.1 What is deployed now (verified)

Live Config DB (`prisma/data/sound-suite.db`): `ocrProvider=ollama`, `ocrOllamaModel=minicpm-v`, host `http://10.10.20.5:11434`, orchestrator on, concurrency 5. `minicpm-v` resolves to **MiniCPM-V 2.6**: qwen2 LM, 7.61B params **Q4_0** (4.4 GB) + CLIP projector 504M F16 (1.0 GB) = **5.5 GB**, 32K context, Ollama library entry ~1 year old.

- [ ] **Reconcile the three conflicting defaults** — DB says `minicpm-v`; app-code fallback says `richardyoung/olmocr2:7b-q8` (`src/services/worker-init.ts:51`, `src/app/api/documents/[id]/reindex-pages/route.ts:110`, `src/components/admin-dashboard.tsx:646`); mode-catalog fallback says `minicpm-v:latest` (`src/lib/gpu/mode-catalog.ts:129`). Pick one source of truth (the DB) and make the fallbacks agree.

## A.2 Benchmark evidence

OmniDocBench v1.6 (from the 1.6 technical report, arXiv 2606.03264, Table 2 — higher is better except Edit ↓):

| Model | Params | Overall ↑ | Text Edit ↓ | Table TEDS ↑ | Reading Order Edit ↓ |
|---|---|---|---|---|---|
| **PaddleOCR-VL-1.6** | 0.9B | **96.33** | **0.033** | **94.76** | 0.127 |
| MinerU2.5-Pro | 1.2B | 95.75 | 0.036 | 93.42 | 0.120 |
| dots.ocr | 3B | 90.77 | 0.048 | 87.18 | 0.138 |
| Gemini 3 Pro | – | 92.91 | 0.064 | 89.15 | 0.165 |
| GPT-5.2 | – | 86.59 | 0.114 | 82.95 | 0.193 |
| olmOCR | 7B | 85.74 | 0.139 | 83.00 | 0.216 |

**MiniCPM-V 2.6 appears on no document-parsing benchmark.** Its "beats GPT-4o" claim is OCRBench (scene-text VQA, ~852/1000) — not comparable to full-page parse edit distance. Nearest proxy: purpose-built olmOCR 7B scores 85.74; a general 8B VLM at Q4_0 is expected at or below that line. Treat the gap as strongly indicated, not directly measured.

Real5-OmniDocBench (degraded real-world scans — most court-relevant): PaddleOCR-VL-1.6 overall **93.19** — scanning 94.74, warping 92.48, screen-photo 92.78, illumination 93.28, **skew 92.66** (classic pipeline OCR: 37.98; DeepSeek-OCR 3B: 63.01). Tables in-house TEDS **91.71**. Handwriting: EN **85.90** / ZH 77.28 — **its weakest category**. Charts RMS-F1 91.74. 109 languages.

## A.3 Expected improvements on our corpus

1. **Dense pleadings / line-numbered court paper** — step change in raw transcription fidelity (Text Edit 0.033).
2. **Skewed/faxed/photocopied exhibits** — the Real5 skew and warping numbers directly target scanned discovery productions.
3. **Financial exhibits** — dedicated `Table Recognition:` head vs our current prompt sentence "For tables use | delimiters".
4. **Clerk stamps / notary seals / file-stamp dates** — dedicated `Seal Recognition:` task; MiniCPM-V has no equivalent.
5. **Hallucination reduction** — fixed-task recognizer cannot editorialize/summarize/loop the way a chat VLM can; transcription errors become case facts, so this is risk reduction, not polish.
6. **VRAM 5.5 GB → ~1.8 GB** (GGUF 936 MB + mmproj 882 MB) — frees the ~5 GB `ss-ocr` budget (`mode-catalog.ts:93`), makes `ocrConcurrency: 5` real, allows role co-residency. ~1.6 GB with 8-way parallelism reported on an 8 GB GPU.
7. **License: Apache-2.0** vs MiniCPM Model License (commercial use requires ModelBest registration).

## A.4 Regressions / risks

- **Fixed-task prompts only** (`OCR:`, `Table Recognition:`, `Formula Recognition:`, `Chart Recognition:`, `Seal Recognition:`, `Spotting:`). Our free-form `OCR_PROMPT` (`src/lib/ingestion/ollama-ocr-engine.ts:23`) is meaningless input to it. Prompt must be **model-conditional**.
- **Two-stage caveat:** benchmarked quality assumes PP-DocLayoutV3 layout/reading-order → per-region recognition → assembler. Whole-page single-call (`Spotting:`) is officially a degraded mode (HF card: transformers example "only supports element-level recognition and text spotting"; llama.cpp support author says whole-page ≠ official-pipeline results). Single-call still beats a chat VLM; just don't expect 96.33.
- **`num_predict: 2048`** likely truncates dense pages under `Spotting:`; the 1.6 report treats Output Truncation as a first-class failure mode. Raise it.
- **`Spotting:` may need the mmproj `image_max_pixels` bumped** 1003520 → 1605632 (`gguf_set_metadata.py`) — must be baked into whatever GGUF we register; the picker can't express it.
- **Handwriting** is its weak spot — benchmark handwritten judicial annotations before relying on it.
- GGUF path less battle-tested than vLLM (closed issues: llama.cpp #22551 Windows-AMD zero output, #25339 eval bug; M4 CPU-only crash #23631).

## A.5 Ollama serviceability (the /admin/ocr answer)

**Confirmed working via Ollama as of 2026-07-05** — issue ollama#12685 closed by maintainer dhiltgen with the `hf download PaddlePaddle/PaddleOCR-VL-1.6-GGUF` + `ollama create` route. Enabler: Ollama 0.30's llama.cpp backend (llama.cpp PR #18825, builds b8984+) + 0.30.4 Metal multimodal fix. **Version floor: treat as ≥0.31.2** (current 0.32.5).

Not in the official Ollama library. Options:

- **(a) Pullable community tag — recommended:** `AuditAid/PaddleOCR-VL-1.6-0.9B` (1.8 GB, vision-tagged, 128K, uploaded post-fix, sourced from official ModelScope GGUF). Keeps the sidecar `ollamaPull` path and `/api/tags` preflight working unchanged across the fleet. **Avoid `MedAIBase/PaddleOCR-VL`** (pre-fix upload, text-tagged — the one that 500'd).
- **(b) Per-host provisioning:** `ollama create` from official GGUF under a consistent name on every GPU host (orchestrator routes per-request, so *every* host needs it). More control (lets us bake the `image_max_pixels` bump), more ops.

Helpful: the `<__media__>` prefix issue is llama-server-only; Ollama's `images: [...]` inserts the media marker itself — our `/api/generate` call shape stays valid.

## A.6 Deployment decision + /admin/roleassign Mac exclusion

**Operator decision (2026-08-05):** `ss-ocr` will run as a **Docker image** (runtime `docker-ollama`, port 11436 per `MODE_PORTS`). Docker Desktop on Mac has **no GPU passthrough** for plain containers (`availableRuntimesForOs` in `admin-role-assignments.tsx:84-86` already encodes this: mac hosts only get `host` and `docker-model-runner`). Therefore **PaddleOCR-VL cannot be served on Mac sidecars** under this deployment, and when PaddleOCR-VL is the selected OCR model, `/admin/roleassign` must not list Mac hosts as assignment targets for the `ss-ocr` chip.

### How the roleassign page filters today (verified)

- The chip grid disables/hides a mode on a sidecar via `mode.availableOn.includes(sidecar.os as ModeOs)` — `src/components/admin-role-assignments.tsx:572` (assignable check) and `:720` (chip render).
- `availableOn` comes from `GET /api/admin/mode-catalog` → `getModeCatalog()` (`src/lib/gpu/mode-catalog-server.ts:36-42`), which **already reads Config per request** — the perfect place to make `ss-ocr`'s `availableOn` model-dependent. `MODE_METADATA` (`src/lib/gpu/mode-catalog.ts:89-94`) currently hardcodes `ss-ocr: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2']`.
- Precedent already exists: `ss-reranker` and `ss-rlm` exclude Mac via `availableOn` (`mode-catalog.ts:98,111`) and the UI comment at `admin-role-assignments.tsx:99-104` explicitly says OS exclusions belong in `availableOn`, not in `runtimesForMode`.
- `defaultModelForAsync` (`mode-catalog-server.ts:48-56`) returns null for unavailable OS — the master's model-push path respects the same list.

### Implementation plan

1. **New shared caps module `src/lib/gpu/ocr-model-caps.ts`** (pure, client-safe — imported by both server catalog and client components):
   ```ts
   interface OcrModelCaps {
     promptStyle: 'instruction' | 'fixed-task';
     fixedTaskPrompt?: string;   // 'OCR:' | 'Spotting:' etc.
     macCompatible: boolean;     // false ⇒ strip 'mac-docker-ollama' from ss-ocr availableOn
     numPredict: number;
   }
   function ocrModelCaps(model?: string): OcrModelCaps
   ```
   Detection by pattern (`/paddleocr/i`), not exact id, so `AuditAid/...`, a locally-`ollama create`d name, or a future 1.7 tag all resolve correctly. Default = instruction / macCompatible / 2048 (today's behavior for minicpm-v, olmOCR, llama3.2-vision).
2. **`getModeCatalog()` + `defaultModelForAsync()`** (`mode-catalog-server.ts`): for `ss-ocr`, compute effective `availableOn` — when `!ocrModelCaps(resolveModelFromConfig('ss-ocr', cfg)).macCompatible`, strip `'mac-docker-ollama'`. Roleassign UI then stops listing Mac hosts for ss-ocr **automatically** (no UI change needed), and the master stops pushing the model to Mac sidecars.
3. **`/admin/ocr` picker** (`admin-dashboard.tsx:637-641`): add `{ id: 'AuditAid/PaddleOCR-VL-1.6-0.9B', label: 'PaddleOCR-VL 1.6 (~1.8 GB) — Best document parsing, Apache 2.0', vram: '~2 GB' }`; info box notes "Docker-only — not available on Mac hosts" driven by `ocrModelCaps`.
4. **`OllamaOCREngine`** (`ollama-ocr-engine.ts:29,170,175`): prompt + `num_predict` from `ocrModelCaps(this.model)` instead of the hardcoded `OCR_PROMPT` and `2048`.
5. **Effective-model enforcement at every layer** (deepened 2026-08-05): eligibility must follow the *effective model per host* — `modelOverride ?? global pipeline.ocrOllamaModel` — not just the global dropdown. MiniCPM selected → Mac assignable; PaddleOCR-VL selected → Mac excluded, *unless* the Mac row carries a Mac-compatible override. Four layers:
   - **UI (catalog)**: `getModeCatalog()` strips Mac from `ss-ocr.availableOn` on a Docker-only global model; the roleassign row check additionally honors a Mac-compatible per-host `modelOverride` as an escape hatch (`ocrOverrideEscape` in `admin-role-assignments.tsx`) and shows a mode-correct ⓘ tooltip.
   - **Assignment API**: `POST /api/admin/role-assignments` computes the effective model (body override → existing row override → global config) and returns 400 when enabling ss-ocr on a Mac host with a Docker-only effective model — UI filtering alone is bypassable.
   - **Config push**: `filterModesForHost()` in `pushModelRegistry` / `pushFullConfig` drops ss-ocr from the `enabledModes` + `registry` payload for Mac hosts whose effective model is Docker-only (logged as a warn) — a stale pre-switch assignment stops being provisioned at the next push.
   - **Request routing**: `resolveEndpoint('ocr')` phase-1 skips Mac sidecars whose *running container's* config.model is Docker-only — covers the window where a pre-switch container still reports `running`.
6. **Sidecar provisioning**: the `AuditAid` tag keeps sidecar `ollamaPull` working; the docker-ollama container for ss-ocr pulls it like any registry model. Verify fleet Ollama versions ≥0.31.2 (`/api/version` per host; llama.cpp backend + Metal multimodal fixes irrelevant here since Mac is excluded, but Linux/Windows docker-ollama images must be ≥0.31.2 too).

## A.7 Remaining work items (Phase A)

- [x] `ocr-model-caps.ts` caps module (plan item 1) — **done 2026-08-05**, `src/lib/gpu/ocr-model-caps.ts`
- [x] Model-aware `availableOn` in `getModeCatalog` / `defaultModelForAsync` (plan item 2) — **done 2026-08-05**, `mode-catalog-server.ts` `effectiveAvailableOn()`
- [x] Picker entry + Docker-only note on `/admin/ocr` (plan item 3) — **done 2026-08-05**, `admin-dashboard.tsx`
- [x] Model-conditional prompt + `num_predict` in `OllamaOCREngine` (plan item 4) — **done 2026-08-05**, `ollama-ocr-engine.ts` (existing 10 tests pass)
- [x] Effective-model enforcement: assignment-API validation, push-time `filterModesForHost`, routing guard in `resolveEndpoint`, UI override escape hatch (plan item 5) — **done 2026-08-05**
- [ ] Optional polish: save-time notice on `/admin/ocr` listing which Mac hosts will be skipped (enforcement already handles them; this is operator visibility only)
- [ ] Verify docker-ollama image versions ≥0.31.2 across fleet (plan item 6) — **tooling added 2026-08-05**: `ocr-model-caps.minOllamaVersion` ('0.31.2' for PaddleOCR-VL) + `/api/admin/gpu-fleet/ocr-version` probe; the fleet panel's OCR row now shows a red "Ollama X < Y required" badge per sidecar. Remaining: actually update stale hosts (`docker pull ollama/ollama` + remove the ss-ocr container so the sidecar recreates it — observed 0.24.0 on the TITAN RTX host 2026-08-05).
- [x] **First live PaddleOCR-VL test (2026-08-05): SUCCESS.** Operator switched `/admin/ocr` to `AuditAid/PaddleOCR-VL-1.6-0.9B`; reindexed two image-only pages of a 1403-page clerk's record whose embedded text layer has no word spacing. Both pages went through the **full-page render fallback** (embedded images below size thresholds), fleet-router resolved an OCR host, preflight passed, `OCR:` fixed-task prompt used, **~6 s/page**, output is clean properly-spaced legal text (affidavit transcribed correctly, caption block preserved, exhibit label captured). Quirk noted: the caption's `§` section symbols rendered as `$`. Remaining from this test: the reindex path only re-OCRs pages with density < 50 — space-less-but-dense text-layer pages are untouched; fixing the whole file needs a full reprocess (delete + re-ingest) or a force-OCR option on reindex-pages.
- [ ] A/B on a table-heavy + a handwritten filing: MiniCPM-V vs PaddleOCR-VL `OCR:` vs `Spotting:`; decide the default task; document the choice.
- [ ] Deferred (Phase 3 of the roadmap doc): full PP-DocLayoutV3 two-stage pipeline as a vLLM sidecar service (`paddleocr-genai-vllm-server` ContainerDef) — the benchmarked-quality path; new service, not a model swap.

---

# Part B — AI Readiness Score: detailed change report

> **Status 2026-08-05: IMPLEMENTED** (items 1–9 of §B.7). Modules at `src/lib/ingestion/readiness/{types,detectors,score,collect}.ts` + `__tests__/` (32 tests passing). Columns added via direct SQL (`prisma db push` blocked by pre-existing Jurisdiction/Json-default drift — see §B.4 note below; DB backed up to `sound-suite.db.bak-readiness`). Config keys `pipeline.readinessEnabled/Threshold/Gating` live in `AppConfig`. Scoring wired into the verification block before `clearCheckpoint`, persisted on the final Document update (gating `'warn'` default, `'block'` sets ERROR). Stage-name bug (`'vector-indexing'`→`'verification'`) fixed. Surfaced: `/api/documents` select, document-grid badge with warning tooltip, `/vectors` document pickers show "· score BAND" (⚠ on RISKY/POOR). Item 10 (relax OCR hard-fail) remains open — until it lands, PARSE_ERRORS mainly reflects `renderFailed` pages.
>
> **Backfill (added 2026-08-05):** `GET/POST /api/admin/readiness-backfill` scores already-INDEXED documents. PageCache is gone for those, so it reconstructs per-page signals from LanceDB chunk text grouped by `page_number` (falling back to PageCache when it survives, e.g. post-reindex); estimate-path scores carry a `BACKFILL_ESTIMATE` info warning (no OCR provenance — reprocess for an exact score). Body: `{caseId?, documentIds?, force?, limit?}`; `force=true` rescores. **Ran against the live corpus: all 79 INDEXED docs scored — 24 HIGH / 9 OK / 37 RISKY / 6 POOR.** The POOR band is dominated by Reporter's Record volumes and clerk's-record scans — consistent with the known RR gap (dead `extractTextForRR`, no transcript-class density suppression); treat RR scores as conservative until that lands.
>
> **Per-chunk score (added 2026-08-05):** LanceDB chunk rows now carry `readiness_score` (Int, −1 = unscored; new inserts default it, `VectorStore.stampReadinessScore()` stamps the document score onto all of a doc's chunks after verification, and the backfill stamps too). `/api/vectors` returns it (`Number()`-coerced — LanceDB Int64 comes back as BigInt) and `/vectors` table view shows a color-banded Score column. **Data-hygiene note (investigated 2026-08-05, initially misreported as orphans):** chunks whose `document_id` has no Document row are NOT stale garbage. Full audit of all 36,656 rows: 36,542 belong to live Documents; 109 belong to **live Draft rows** (drafts are indexed under their Draft id — the /vectors page lists them as 📝 pseudo-documents); and 5 are **intentional synthetic `filing-index-<caseId>` chunks** written by the filing-index stage (`ingestion-pipeline.ts:1984`). Zero true orphans — no cleanup needed. These non-Document chunks legitimately show "—" in the Score column (drafts/filing-indexes aren't readiness-scored). If drafts should get scores later, stamp from `Draft.indexingStatus` metadata analogously.

Native TS scoring design (baselines + penalty table below in §B). All line numbers verified at commit `095b646`.

## B.0 Three architecture-shaping findings

1. **`PageCache` is deleted on success.** `clearCheckpoint` (`src/lib/ingestion/ingestion-pipeline.ts:357-367`) does `pageCache.deleteMany` and nulls `ingestCheckpoint`; called at :950, right before `INDEXED` at :960. Every per-page signal is destroyed seconds after it exists. → **Scorer must run in the verification block (:907-933), before :950; output goes to `Document` columns, not the checkpoint blob.**
2. **Verification output is already thrown away.** `verifyIndexing` (:911) results are stashed into `ingestCheckpoint` (:922) "for admin visibility" — then :950 nulls that field. Persisting readiness fixes this as a side effect.
3. **One OCR page failure kills the whole document.** :1395 collects `pageErrors`; :1486-1489 throws "failing entire document" → `ERROR`. The graded −12/page penalty is unreachable until this hard-fail becomes a tolerance (item B.7 #10).

## B.1 Signal inventory

Extend `VerificationResult` (`src/lib/ingestion/indexing-verifier.ts:11-26`) — it already computes half the inputs and already does the `pageCache.findMany` (:52-55, currently selecting only 4 fields and discarding text).

| Input | Status | Where |
|---|---|---|
| Missing/gap pages | exists | `indexing-verifier.ts:66-72` (`gapPages[]`, `pagesWithoutText`) |
| OCR page count | exists | `indexing-verifier.ts:69-71` (`source === 'ocr'`) |
| Per-page text density | exists | `PageCache.textDensity` (`prisma/schema.prisma:170`); OCR predicate `ingestion-pipeline.ts:1248` |
| Chunk count vs pages | exists | `indexing-verifier.ts:82-88` |
| Render/parse failure | exists, not persisted | `PageText.renderFailed` (`pdf-parser.ts:42`); consumed at :1248/:1277, never written to PageCache — needs plumbing |
| OCR page errors | in-memory only | `ingestion-pipeline.ts:1395, 1471` — needs surfacing to `processDocument` |
| Image-only fraction | derivable | `source==='ocr'` ÷ total **plus** pages that are low-density with `source='extract'` because OCR fell under the 100-char gate (:1436) — a naive source count misses those |
| Headings on multipage | reusable | `isSectionHeading` (`legal-text-splitter.ts:71-78`); zero hits across ≥2 pages → −6 |
| GLYPH_ARTIFACTS | **new detector** | see B.2 |
| REPEATED_CONTENT | **new detector** | see B.2 |
| TOKEN_BLOAT | **new detector** | see B.2 |
| NEAR_EMPTY_OUTPUT | new, trivial | total chars below floor |

## B.2 New detectors (pure TS, dependency-free)

**GLYPH_ARTIFACTS (−25)** — CID-font garbling: plausible-but-wrong text, worse than a blank. 2-of-3 rule (signal 1 alone may fire), guarded by `totalChars >= 500`, skipped for OCR-sourced pages (that failure is priced by OCR_REQUIRED):

1. Replacement/CID ratio: `(U+FFFD count + /\(cid:\d+\)/g matches) / totalChars > 0.02` — highest precision, sufficient alone.
2. Dictionary-word ratio: tokens ≥3 chars vs an in-repo ~2-3k `Set<string>` (English function words + legal vocabulary: plaintiff, defendant, exhibit, affidavit, subpoena, movant, respondent…). Healthy court text >0.55; garbled <~0.25.
3. Character-bigram Shannon entropy: English prose ~3.3–3.9 bits; scrambled CID output >4.3. Tiebreaker.

**REPEATED_CONTENT (−8)** — must not fire on legitimate per-page headers/footers/captions/Bates stamps:

- Normalize lines (collapse whitespace, strip digits so "Page 3 of 40"≡"Page 4 of 40", lowercase).
- Lines on `> 0.8 × pageCount` = boilerplate → excluded.
- Fire when >~0.30 of remaining lines are duplicates (stuck extractor / OCR loop), **or** identical page text across ≥3 pages post-normalization (render loop).

**TOKEN_BLOAT (−8)** — whitespace+punct : alphanumeric ratio >~1.5, or mean token length <2.0 (per-character text runs; the RR positional path is prone to this when the transform matrix is misread).

## B.3 Module layout

New `src/lib/ingestion/readiness/`:

- `types.ts` — `ReadinessSignals`, `ReadinessWarning {code, severity, detail, pages?}`, `ReadinessResult {score, band, baseline, warnings, signals}`, `ReadinessBand`, `WarningCode` union.
- `detectors.ts` — pure sync functions: `detectGlyphArtifacts`, `detectRepeatedContent`, `detectTokenBloat`, `detectHeadings`, `classifyBaseline`.
- `score.ts` — `computeReadiness(signals, opts?)`: **pure, no I/O** — baseline → penalties → suppressions (`OCR_REQUIRED` suppresses `NEAR_EMPTY_OUTPUT` + `LOW_TEXT_DENSITY`) → clamp → band. Pure = table-testable; the scoring table is what will churn during tuning.
- `collect.ts` — only I/O file: `collectSignals(documentId, pageCount, chunkCount, db)`; folds caller-supplied parse-error/renderFailed tallies.

**Wire-in point:** verification block :907-933, right after `verifyIndexing` (:911), before `clearCheckpoint` (:950). Have `verifyIndexing` return the page rows it already loads (add `text` to its select) — avoid a second full PageCache read on a 2000-page RR.

**Incidental bug to fix while there:** verification publishes progress under stage name `'vector-indexing'` (:909) instead of the declared `'verification'` (`pipeline-stages.ts:19`) — the UI never shows the verification stage.

## B.4 Schema + config

`Document` (`prisma/schema.prisma:71-106`) — additive nullable columns, safe for `prisma migrate deploy` (back up `prisma/data/sound-suite.db` first; never `migrate dev`):

```prisma
readinessScore    Int?
readinessBand     String?   // 'HIGH' | 'OK' | 'RISKY' | 'POOR'
readinessWarnings Json?     // ReadinessWarning[]
readinessScoredAt DateTime?
@@index([readinessBand])
```

Do **not** stuff the score into `Document.tags` (that's the XETO/Haystack marker bag; JSON-path queries in SQLite are painful). Optional: `PageCache.renderFailed Boolean @default(false)`.

Config keys, following the exact `src/lib/db/config.ts:176-260` accessor pattern (+ `AppConfig` fields, ends :161):

```ts
const accessors = {
  readinessEnabled:   configMap.get('pipeline.readinessEnabled') !== 'false',
  readinessThreshold: parseInt(configMap.get('pipeline.readinessThreshold') || '70', 10),
  readinessGating:    (configMap.get('pipeline.readinessGating') as any) || 'warn', // 'off'|'warn'|'block'
};
```

## B.5 Status flow — no new status

`Document.status` is a plain String (no enum); six values in use: QUEUED, PROCESSING, INDEXED, ERROR, STOPPED, DISCOVERED. **Do not add NEEDS_REVIEW:**

- UI unions are already out of sync (`document-grid.tsx:17`, `case-view-wrapper.tsx:27` omit DISCOVERED); the `as const` colour maps (`document-grid.tsx:64-86`) break on unmapped values.
- A low-readiness doc *is* indexed and searchable; hiding it from `status:'INDEXED'` queries (incl. `partial-status/route.ts:18`) is wrong.
- Precedent exists: `document-grid.tsx`'s `isPartial` amber-dot pattern. `readinessBand ∈ {RISKY, POOR}` drives amber/red on an INDEXED card; warnings in the detail panel. (`partial-status` does a full LanceDB scan per call to compute a cruder version of this — candidate for later replacement by the band.)

Gating by `pipeline.readinessGating`: `'warn'` (default) surfaces only; `'block'` sets `ERROR` with readiness-derived `errorMessage`.

**API:** add the three fields to selects in `src/app/api/documents/route.ts:23-33` and `src/app/api/documents/[id]/route.ts`; optional per-case rollups in `src/app/api/cases/route.ts`. **UI:** `document-grid.tsx`, `case-view-wrapper.tsx`, optional admin-dashboard column.

## B.6 Baseline table (adapted to our corpus)

| Format class | Baseline | Detection |
|---|---|---|
| Native text-layer PDF (e-filed motion/order/brief) | 90 | mean pre-OCR density ≥400, renderFailed=0 |
| Reporter's Record transcript (text layer) | 88 | **see caveat** |
| Mixed text + scanned exhibits | 80 | 5–40% pages < ocrThreshold |
| Scanned PDF, clean | 72 | >60% low-density, OCR confidence ≥80 |
| Scanned PDF, degraded (fax/photocopy) | 62 | >60% low-density, OCR confidence <80 |
| Image-only, no OCR result | 45 | image pages, OCR <100 chars (:1436 gate) |

Extra suppression: suppress `LOW_TEXT_DENSITY` for the transcript class — line-numbered pages are legitimately sparse.

**⚠️ RR caveat (escalate):** `PDFParser.extractTextForRR` (`pdf-parser.ts:533`) has **zero callers** — the RR-aware path is dead code; transcripts go through the generic extractor which collapses line numbers. Either wire it up first or drop the RR row and score transcripts as generic text-layer PDFs. Don't score highly on a code path never taken.

## B.7 Work items + estimates

| # | Item | Est. |
|---|---|---|
| 1 | `types.ts` + pure `score.ts` | 3–4 h |
| 2 | `detectors.ts` (glyph, repetition, bloat, headings + wordlist) | 6–8 h |
| 3 | `collect.ts` + extend `VerificationResult` to return page text | 3–4 h |
| 4 | **Plumb `pageErrors` + `renderFailed` up to `processDocument`** (the real refactor) | 4–6 h |
| 5 | Prisma migration + `AppConfig` keys (backup DB; `migrate deploy`) | 1–2 h |
| 6 | Wire into verification block + fix `'vector-indexing'`→`'verification'` stage name | 2–3 h |
| 7 | API selects (2–3 routes) | 1–2 h |
| 8 | UI band on grid + warnings in detail panel (reuse `isPartial` pattern) | 4–6 h |
| 9 | Tests (below) | 6–8 h |
| 10 | Relax hard OCR-failure abort into tolerance (**recommended** — else parse-error penalties unreachable) | 3–5 h |

**Total: 33–48 h** (items 1–9); sequence 1→2→9 first (pure, validates the scoring table before pipeline surgery); item 4 on its own branch with `ingestion-pipeline.test.ts` as the net.

## B.8 Test plan

Convention: `src/lib/ingestion/__tests__/*.test.ts`, Jest+ts-jest, mocks hoisted before imports (`ingestion-pipeline.test.ts:12-40` is the reference); no fixtures dir — inputs built inline.

- `readiness/__tests__/score.test.ts` — table-driven `[signals, expectedScore, expectedBand]`: each penalty in isolation, cap boundaries (2/3/4 parse errors → −24/−30/−30), both suppressions, clamping. No mocks.
- `readiness/__tests__/detectors.test.ts` — inline strings: `(cid:` page, U+FFFD page, clean legal page (must NOT fire), all-caps caption block, repeated header/footer doc (must NOT fire), 3 identical pages (must fire). Assert computed ratios, not just booleans, so threshold tuning is a one-number edit.
- `readiness/__tests__/collect.test.ts` — mocked `pageCache.findMany`; image-only-fraction arithmetic incl. the low-density-but-`source='extract'` case.
- Extend `ingestion-pipeline.test.ts`: assert `document.update` receives score/band **before** `clearCheckpoint` — the single most breakable ordering property.
- Real-PDF fixtures (garbled CID, fax scan): optional follow-up, no binary-fixture precedent in repo.

## B.9 Synergy note

Ship B before or alongside A: the readiness score is model-independent and its score distribution across the corpus is the natural **A/B metric** for the MiniCPM → PaddleOCR-VL switch (re-OCR a sample, compare bands).
