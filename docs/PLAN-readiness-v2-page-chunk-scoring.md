# PLAN: Readiness v2 — per-page & per-chunk scores, blank-page handling, page-average model

**Date:** 2026-08-06
**Status:** design complete (two-agent research), not yet implemented — **SEQUENCED AFTER the ss-docparse hybrid work** (`PLAN-ss-docparse.md` @ e828a8c): start Phases 1–3 here once docparse lands.
**Parents:** `TODO-paddleocr-vl-and-readiness-score.md` §B (v1 implementation), tasks #6/#8 (reindex path)

**Couplings with the docparse hybrid to respect when this starts:**
1. **Phase 3 chunk scoring must target the StructuredChunker output**, not the current LangChain chunker — heading-aware/structured chunks may span pages, so the "chunk score = min over spanned pages" rule (noted as future in the design) becomes the real rule, and chunk-local modifiers should run on block text, not raw page text.
2. **The pdfjs structure pass gives readiness better signals for free**: real heading detection (font size/weight) should replace the regex-based `NO_HEADINGS` heuristic, and furniture detection can exclude page-number strips from the runt-chunk check.
3. **Shared bug: `CachedOCREngine` cache key ignores the task prompt** — docparse's per-task prompts (`Table Recognition:` etc.) on the same crop would collide with plain `OCR:` results. Whoever touches it first fixes it for both; readiness re-OCR flows through the same cache.
4. Docparse's per-task quality-gate profiles and readiness page/chunk flags should stay one vocabulary (`WarningCode`) rather than growing two parallel taxonomies.

## 0. Findings that motivate v2 (beyond the feature asks)

Two calibration bugs in the v1 model, found by reconstructing and running it:

1. **Scanned documents are priced twice.** `classifyBaseline` already lowers the baseline for scans (90→72/62), then `OCR_REQUIRED` subtracts up to −40 for the *same* pages. A 50-page clean scan with 93%-confidence OCR scores **32 POOR** — clearly miscalibrated.
2. **The image-only 45 baseline is unreachable.** `pagesWithText === 0` implies all pages are gaps, so the score is always driven to 0 by capped penalties. Also `PARSE_ERRORS` + `MISSING_PAGE` double-count errored pages.

## 1. Blank pages (Phase 1 — small, ship first)

**Bug:** genuinely blank pages (separators/back pages) are penalized as `MISSING_PAGE`. The `source='empty'` convention exists (reindex route writes it, page-report reads it) but the scorer never consults it — and today `'empty'` actually means "OCR gave up", not "page is blank", so wiring it in naively would erase real gaps.

**Classification — a page is `blank` only if ALL hold:**
1. no embedded text layer (density 0, empty text);
2. full-page render succeeded AND is not the placeholder JPEG (`createPlaceholderJpeg` in `pdf-page-renderer.ts:336` returns a valid buffer on failure — add a `placeholder: boolean` to `RenderResult`);
3. OCR of the render returned empty;
4. **ink coverage < 0.002** on the render (sharp: greyscale → resize 1000w → raw; crop 5% margins to ignore scanner edge bands/punch holes; count pixels < 200).

**When signals conflict → classify `missing`, never `blank`** (a false missing costs points and is reviewable; a false blank silently deletes a real gap).

**Wiring:** extend `PageTextLike.source` with `'empty'`; tighten the reindex route's `'empty'` write to require the ink check; add blank classification to the main pipeline (only for pages that would otherwise be gaps — cheap); split `indexing-verifier` gaps into `gapPages` + `blankPages`; scorer: blanks excluded from quality average and fraction denominators (not from displayed pageCount), zero penalty, new `BLANK_PAGES` info warning.

Phase 1 alone: clerk record 57 → 65 under the current model.

## 2. Aggregation model (Phase 2 — the rewrite)

**Principle: content quality dilutes with document size; retrieval integrity does not.**

```
Q     = mean over non-blank pages of pageQuality(p)
score = clamp(0..100, round(Q − Σ integrity penalties))
band  = bandForScore(score)          // thresholds UNCHANGED (85/70/50)
```

**Per-page quality ladder:** text 95 · text-thin (density<150) 70 · ocr-high (conf≥90 or unreported) 80 · ocr-mid 70 · ocr-low (<75) 50 · glyph-fired 0 · missing 0 · blank excluded.
Per-PAGE, not per-chunk: chunk averages weight by chunker config and structurally cannot see missing pages (no chunks = no contribution).

**Integrity penalties (the only subtractions):**
- `MISSING_PAGE`: `min(40, 10 + round(45 × √(missing/effectivePages)))` — floor 10 so one invisible page always costs a band's worth; √ curve (1/1403→−11, 3/10→−35).
- `REPEATED_CONTENT` −8 (record-compilation suppression stays), `TOKEN_BLOAT` −8, `NO_HEADINGS` −6, `LOW_CHUNK_COUNT` −10.
- **Removed as penalties** (absorbed by the ladder, kept as warnings): `OCR_REQUIRED`, `GLYPH_ARTIFACTS`, `LOW_TEXT_DENSITY`, `NEAR_EMPTY_OUTPUT`; `PARSE_ERRORS` folds into `missing`. `classifyBaseline` becomes a label only.
- **Safety rule:** any `critical` warning caps the score at 84 (can't be HIGH with a missing page).

**Worked results (computed):** 1403p record 57→**89 HIGH** (38 glyph pages remain listed in warnings); 10p motion w/ 3 garbled 65→67 RISKY (no small-doc leniency — glyph pages score 0); image-only 0→0 POOR; pristine e-filed 90→95; clean scan conf-93 **32 POOR → 80 OK** (bug fixed); 1 missing page in 1403 → 81 OK (floor working).

**Migration:** add `Document.readinessModelVersion` (v2 const); backfill selects `modelVersion != 2` (no force needed); **estimate-path caveat:** chunk-reconstructed pages can't distinguish blank from missing — under BACKFILL_ESTIMATE set the missing-page penalty to 0 and downgrade to `warning`. Existing band thresholds/UI badges unchanged.

## 3. Per-page + per-chunk scores (surfaces: /vectors/pagereport, /vectors/tableview)

**Constraint:** PageCache dies at ingest completion → per-page scores must be computed in the verification window and persisted. New Prisma model:

```prisma
model PageScore {
  id String @id @default(uuid())
  documentId String
  pageNumber Int
  score Int
  band String
  pageClass String   // ladder class above
  flags String       // JSON WarningCode[] (+ BACKFILL_ESTIMATE on estimate rows)
  textDensity Int
  source String      // snapshot: 'extract' | 'ocr' | 'empty'
  confidence Float?
  chunkCount Int
  scoredAt DateTime @default(now())
  @@unique([documentId, pageNumber])
  @@index([documentId])
}
```

(Hand-written migration + `migrate deploy`, DB backup first — never `migrate dev`. Snapshotting density/source also fixes the page-report showing 0/null for indexed docs.)

- **Page score** = the v2 ladder value minus page-local flags — new pure module `readiness/page-score.ts` (`computePageScores`), sharing `pageGlyphMetrics` (export it; add `perPage` map to `GlyphFinding`).
- **Chunk score** = its page's score (chunks are single-page — `langchain-text-chunker.ts:236`; if multi-page ever, use min) with chunk-local modifiers: strip `[Case: ...]` header; body-level glyph on ≥400 chars → clamp ≤40; runt body <120 chars → −10. LanceDB `readiness_score` column **changes meaning: document → chunk score**.
- **Stamping cost:** bucket LanceDB updates by score value (`page_number IN (...)` chunked at ~500) — typical docs collapse to 2–5 updates; individual `id IN` updates only for chunks whose local modifiers diverge; skip modifiers above ~20k chunks (log). Timing-check against the largest doc before enabling in the live path; fallback = Prisma-only in pipeline + LanceDB stamping via backfill.
- **UI:** pagereport gets Score column (sortable, badge, flags tooltip, mean/risky/poor rollup); tableview Score column becomes the true chunk score (retitle/tooltip so it doesn't read as the document score; sorting by score then lands directly on pages needing repair).

## 4. Sequencing & effort

| Phase | Content | Effort |
|---|---|---|
| 1 | Blank-page classification + verifier split + scorer exclusion | ~4h |
| 2 | Aggregation rewrite (score.ts v2, modelVersion, backfill migration, new fixtures a/b/e/f + blank-vs-missing pair) | ~6h |
| 3 | PageScore table + page-score module + pipeline/backfill wiring + bucketed chunk stamping + both UIs | ~18h |

Phase 1 is strictly correct under either model — ship first. Phase 2 before Phase 3 so page scores are born on the v2 ladder. Keep document-score chunk stamps until Phase 3 flips them deliberately.
