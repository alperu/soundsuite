# Report: Current Ingestion vs PaddleOCR-VL-1.6 — Where It Benefits Us, and the /admin/ocr Question

**Date:** 2026-08-05
**Companion docs:** `research-baidu-ocr-models.md`, `research-ocr-structured-parsing-roadmap.md`
**Detailed work plans:** `TODO-paddleocr-vl-and-readiness-score.md`

---

## 1. What we run today

**Deployed OCR (verified against the live Config DB, `prisma/data/sound-suite.db`):**

```
pipeline.ocrProvider        = ollama
pipeline.ocrOllamaModel     = minicpm-v            ← MiniCPM-V 2.6, 8B Q4_0, 5.5 GB
pipeline.ocrOllamaHost      = http://10.10.20.5:11434
pipeline.ocrUseOrchestrator = true
pipeline.ocrConcurrency     = 5
```

⚠️ **Config drift worth fixing regardless of any model decision:** the app-code fallback default is `richardyoung/olmocr2:7b-q8` (`worker-init.ts:51`, `reindex-pages/route.ts:110`, `admin-dashboard.tsx:646`) while the GPU mode-catalog fallback is `minicpm-v:latest` (`mode-catalog.ts:129`) and the DB says `minicpm-v`. Three "defaults", one truth.

**Pipeline shape** (15 stages, `src/lib/pipeline-stages.ts`): pdfdown native text extraction with pdfjs fallbacks → OCR fallback stage for pages with `renderFailed || textDensity < 50` → per-page `PageCache` → chunking → embedding → LanceDB. OCR sends **one whole rendered page (actually: the single best *embedded* image — see gap 3)** to Ollama `/api/generate` with a free-form instruction prompt (`ollama-ocr-engine.ts:23`), `num_predict: 2048`, temp 0.

**The gaps** (full audit in `research-ocr-structured-parsing-roadmap.md`):

1. **No table extraction** — the only table handling anywhere is the prompt sentence "For tables use | delimiters", and the chunker shreds pipe tables at 1000 chars with no header repetition.
2. **MiniCPM-V 2.6 is the wrong class of model** — a year-old general chat VLM, not a document parser. It's absent from every document-parsing benchmark (its "beats GPT-4o" claim is OCRBench scene-text VQA, not document parsing). Chat VLMs editorialize, summarize, and loop on dense text — exactly why our prompt has to plead "No commentary. Stop when all text is extracted."
3. **Vector-only pages are skipped entirely** — OCR fires only when a page contains an embedded raster image (`pageHasImages()` gate); `renderPageToImage()` exists but is unused on this path.
4. **Quality is invisible** — garbage OCR reaches `INDEXED` with no score, no warnings (readiness score fixes this; §4).
5. **Licensing:** MiniCPM-V 2.6 weights are under the MiniCPM Model License — commercial use requires registration with ModelBest. We are a commercial product. PaddleOCR-VL-1.6 is Apache-2.0 outright.

## 2. Where PaddleOCR-VL-1.6 benefits us

Head-to-head summary (full data in the TODO doc):

| Axis | MiniCPM-V 2.6 (now) | PaddleOCR-VL-1.6 |
|---|---|---|
| Class | General chat VLM, mid-2025 | Purpose-built document parser, Jun 2026 |
| Params / VRAM | 8B Q4_0, **5.5 GB** | 0.9B, **~1.8 GB** (GGUF + mmproj) |
| OmniDocBench overall | not benchmarked (n/a) | **96.33** (olmOCR 7B: 85.74; GPT-5.2: 86.59) |
| Table TEDS | n/a (prompt-based pipes) | **94.76** + dedicated `Table Recognition:` task |
| Degraded scans (Real5) | n/a | **93.19** overall; skew 92.66 (classic OCR: 37.98) |
| Seals/stamps | none | dedicated `Seal Recognition:` task |
| Handwriting | untuned | 85.90 EN (its *weakest* area — benchmark before relying) |
| Hallucination | chat-model risk | fixed-task recognizer — can't editorialize |
| License | registration for commercial use | **Apache-2.0** |

Concrete wins for court documents:

- **Transcription fidelity on dense pleadings** — Text Edit 0.033 vs olmOCR-7B's 0.139; a general 8B Q4 VLM is expected at or below the olmOCR line.
- **Skewed/faxed/photocopied exhibits** — the Real5 skew number is the single most court-relevant benchmark result; scanned discovery productions are full of exactly this.
- **Financial exhibits** — a real table-recognition head instead of a prompt suggestion.
- **Clerk stamps, notary seals, file-stamp dates** — first-class task.
- **Hallucination risk reduction** — transcription errors become case facts; a fixed-task recognizer can't answer-instead-of-transcribe.
- **VRAM: 5.5 → 1.8 GB** — frees the `ss-ocr` slot (budgeted ~5 GB in `mode-catalog.ts:93`), raises the practical value of `ocrConcurrency: 5`, allows co-residency with other roles.

**The one caveat that dominates:** the 96.33 benchmark is for Baidu's **two-stage pipeline** (PP-DocLayoutV3 layout+reading-order → 0.9B VLM per region → assembler). Our pipeline sends one whole page per call. Single-call mode uses the `Spotting:` task — a much better recognizer than MiniCPM-V, but *not* the benchmarked layout/reading-order quality. Both the HF model card and the llama.cpp support author confirm whole-page single-call is a degraded mode. Phase the adoption accordingly (see TODO doc).

## 3. Should we add PaddleOCR-VL to the `/admin/ocr` vision-model picker?

**Yes — but it is not a pure dropdown change.** Three facts from the code and from upstream:

1. **Ollama can now run it.** Ollama issue #12685 was closed 2026-07-05 by a maintainer confirming the architecture works (llama.cpp backend added in Ollama 0.30, Metal multimodal fix in 0.30.4; treat **≥0.31.2** as the floor — current is 0.32.5). But there's **no official library entry**: the maintainer's route is `hf download PaddlePaddle/PaddleOCR-VL-1.6-GGUF` + `ollama create`. The one plausible *pullable* community push is **`AuditAid/PaddleOCR-VL-1.6-0.9B`** (1.8 GB, vision-tagged, uploaded after the fix). Avoid `MedAIBase/PaddleOCR-VL` (pre-fix, text-tagged, the one users reported 500s on).
2. **Our fleet assumes pullable tags.** `ocrUseOrchestrator=true` routes per-request across GPU hosts; the sidecar `ollamaPull` path and the `/api/tags` preflight both need the model present under one consistent name on **every** host. So either use the `AuditAid` tag (pull works everywhere) or add a provisioning step that `ollama create`s a consistent name per host.
3. **The prompt must become model-conditional.** PaddleOCR-VL is not instruction-following — it accepts exactly one of `OCR:` / `Table Recognition:` / `Formula Recognition:` / `Chart Recognition:` / `Seal Recognition:` / `Spotting:`. Our current 5-sentence `OCR_PROMPT` (`ollama-ocr-engine.ts:23`) would be meaningless input. The picker currently assumes every entry takes the same prompt — that assumption breaks. Also raise `num_predict: 2048` (truncation is a documented failure mode for dense pages) and note `Spotting:` mode may want the mmproj `image_max_pixels` bump (1003520 → 1605632), which must be baked into the GGUF we register.

**Recommended picker change:** add the entry as

```ts
{ id: 'AuditAid/PaddleOCR-VL-1.6-0.9B', label: 'PaddleOCR-VL 1.6 (~1.8 GB) — Best document parsing, Apache 2.0', vram: '~2 GB' },
```

plus a `promptStyle: 'fixed-task' | 'instruction'` field on the model entries, consumed by `OllamaOCREngine` to select `OCR:`/`Spotting:` vs the current instruction prompt. Small, contained change — detailed in the TODO doc. One helpful detail: the `<__media__>` prefix issue in the llama.cpp threads is llama-server-only; Ollama's `images: [...]` parameter handles the media marker itself, so our `/api/generate` call shape stays valid.

### 3.1 Deployment decision: ss-ocr on Docker image → Mac hosts excluded on `/admin/roleassign`

**Decision (2026-08-05):** `ss-ocr` runs as a **Docker image** (runtime `docker-ollama`, port 11436). Docker on Mac has no GPU passthrough for plain containers — the roleassign UI already encodes this (`availableRuntimesForOs`, `admin-role-assignments.tsx:84-86`: Mac hosts get only native-Ollama and Docker Model Runner). Consequently **PaddleOCR-VL cannot run on Mac sidecars**, and when it is the selected OCR model, `/admin/roleassign` must not list Mac hosts for the `ss-ocr` chip.

The clean mechanism (verified in code): the roleassign page filters chips per sidecar via `mode.availableOn.includes(sidecar.os)` (`admin-role-assignments.tsx:572, 720`), and `availableOn` is served by `getModeCatalog()` (`mode-catalog-server.ts:36-42`), which already reads the Config DB per request. So the fix is **model-aware capability metadata**: a shared `ocrModelCaps(model)` helper (pattern-matched on `/paddleocr/i` so custom tags work) that marks PaddleOCR-VL `macCompatible: false`.

**The deeper rule (implemented 2026-08-05):** eligibility follows the **effective model per host** — per-host `modelOverride` ?? global `pipeline.ocrOllamaModel` — not just the dropdown. MiniCPM-V selected → Mac hosts assignable (served via native host-Ollama); PaddleOCR-VL selected → Mac hosts excluded, *unless* a Mac row carries a Mac-compatible override. Enforced at four layers so no path leaks:

1. **Catalog/UI** — `getModeCatalog()` + `defaultModelForAsync()` strip `mac-docker-ollama` from `ss-ocr.availableOn` on a Docker-only global model; the roleassign row check honors a Mac-compatible per-host override as an escape hatch, with a mode-correct tooltip.
2. **Assignment API** — `POST /api/admin/role-assignments` 400s when enabling ss-ocr on a Mac host whose effective model is Docker-only.
3. **Config push** — `filterModesForHost()` in `pushModelRegistry`/`pushFullConfig` drops ss-ocr from Mac payloads on an incompatible effective model (logged), so stale pre-switch assignments stop being provisioned.
4. **Request routing** — `resolveEndpoint('ocr')` skips Mac sidecars whose running container serves a Docker-only model, covering the window before the next config push lands.

Full plan + work items: TODO doc §A.6–A.7.

## 4. The readiness-score quality gate, and what has to change

The readiness score is the **quality gate we were missing**: a 0–100 score from per-format baselines minus deterministic penalties (`OCR_REQUIRED` up to −40, `GLYPH_ARTIFACTS` −25, `MISSING_PAGE` −4/page, …), banded HIGH/OK/RISKY/POOR at threshold 70. It converts "garbage OCR silently reaches INDEXED" into a visible, actionable signal — the failure mode a lawyer would otherwise discover mid-deposition.

The codebase audit found three facts that shape the implementation (full change report in the TODO doc):

- **`PageCache` is deleted on success** (`clearCheckpoint`, `ingestion-pipeline.ts:357-367`, called at :950 just before `INDEXED` at :960). Every per-page signal the scorer needs is destroyed seconds after it exists → **the scorer must run inside the verification block (:907-933), before :950, persisting to `Document` columns.**
- **Verification results are already thrown away** — `verifyIndexing`'s warnings are stashed in `ingestCheckpoint` and then nulled by the same cleanup. Persisting the score fixes that for free.
- **One OCR page failure currently kills the whole document** (hard-fail at :1486-1489 → `ERROR`). The graded −12/page parse-error penalty only means something if this becomes a tolerance.

Roughly half the scoring signals already exist (`gapPages`, `ocrPages`, `textDensity`, chunk counts in `indexing-verifier.ts`); the new work is three pure-TS detectors (glyph artifacts via CID/replacement-char ratio + dictionary-word ratio + bigram entropy; pathological repetition with boilerplate exclusion so per-page headers/Bates stamps don't false-positive; token bloat), additive nullable `Document` columns, and **no new status** — a `readinessBand` field on INDEXED documents reusing the existing amber `isPartial` UI pattern. Estimated **33–48 h**.

Bonus finding from the audit: the Reporter's Record extractor `extractTextForRR` (`pdf-parser.ts:533`) has **zero callers** — transcripts currently go through the generic path. Don't give RR documents a special readiness baseline until that's wired up (or treat them as generic text-layer PDFs).

## 5. Decision summary

1. **Yes, add PaddleOCR-VL-1.6 to `/admin/ocr`** — via the `AuditAid` Ollama tag + a model-conditional prompt style. Contained change; immediate wins on tables, skewed scans, seals, VRAM, and license posture.
2. **Reconcile the three conflicting model defaults** while in there.
3. **Implement the readiness score first or in parallel** — it's model-independent, costs nothing in GPU, and will also *measure* the MiniCPM→PaddleOCR improvement on our own corpus (score distributions before/after are the A/B evidence).
4. **Defer the full PP-DocLayoutV3 two-stage pipeline** — that's the benchmarked-quality path but a new service, not a model swap. Revisit after single-call mode proves itself.

Work items with full detail: `TODO-paddleocr-vl-and-readiness-score.md`.
