# PLAN: RR transcript structure — line numbers AND structure together

**Date:** 2026-08-06 · **Parent:** `PLAN-ss-docparse.md` (§6.1 carve-out evolution) · task #6
**Status:** IMPLEMENTED (items 1–11, 13) — verified end-to-end on a real 73-page volume:
73/73 pages structured (producer `rr`, speaker turns, 1–25 lines with bboxes) AND 144/145
chunks line-stamped (identical to pre-change baseline — zero delta confirmed live, not just
in the golden test). Item 12 reviewed and REJECTED — see review outcome below.

Operator direction: the transcript carve-out must not mean "no structure for transcripts."
RR volumes get full structure (page → speaker-turn paragraph → lines with printed 1–25 numbers
+ bboxes) for Meta View and provenance, while chunk text remains **byte-identical by
construction** to the legacy line-aware path (citations preserved). Key separation: *producing
structure metadata* ≠ *using structure for chunking*.

Empirical inputs (probed on a real 73-page RR volume from the corpus):
- Split-brain fix confirmed independently: production chunker over `extractTextForRR` text →
  **144/145 chunks stamped** (~99%). Block-derived stamping (item 11) is a precision upgrade,
  not a repair. Mis-stamped volumes need re-ingest, not code.
- `looksLikeTranscriptPage` (≥15 margin numbers) misses caption/index/certificate pages —
  the chunking gate must be **document-level**, not per-page.

## Design decisions

1. **Producer**: refactor `reconstructRRPageText` (`pdf-parser.ts:576-676`) into a pure
   `reconstructRRLines(items): RRLine[]` (lineNumber|null, text, x0/x1/yTop/yBot) + a one-line
   join reproducing today's bytes exactly → byte-identity becomes a **testable refactor
   invariant**. Must additionally capture item width/height and fetch the viewport in
   `extractTextForRR` (bbox needs page height for top-left-origin conversion). New
   `rr-block-producer.ts` builds speaker-turn paragraphs (`^(THE COURT|THE WITNESS|MR\.|MS\.|
   Q\.|A\.)…:` starts a turn) with `lines[]` children; pre-speaker lines → `page_header`
   blocks. Blank numbered lines (`"14  "`) are kept — the 1–25 invariant depends on them.
   Reuses `type:'paragraph'` (no new block type). `buildBlocks`'s `isTranscript → []` stays.
2. **Decoupling**: `PageText.structureOnly?: boolean` declared on **BOTH twin interfaces**
   (`pdf-parser.ts` + `text-chunker.ts` — the §3.1 leak shape; highest-risk item).
   `produceStructuredPages` gains `transcriptDoc` fed from the pipeline's existing `isRR`
   union (single source of truth); when true, ALL pages get RR blocks + `structureOnly=true`.
   `StructuredChunker` filters `!p.structureOnly` → for RR docs `structured` is empty → the
   ORIGINAL pages array delegates wholesale; merge/renumber never runs. Byte-identical by
   construction.
3. **Stamping upgrade** (last, behind comparison logging): map chunk→lines via text containment
   (`line.text.trim().length >= 8 && chunk.text.includes(line.text)`; offsets don't survive the
   SAC prefix), min/max lineNumber; fallback `detectLineNumbers`. Must run BEFORE annotation
   markers are prepended (~`:946`). Promote to authoritative only after disagreement review.
4. **Schema (additive)**: `BlockProducer += 'rr'`; `DocparseBlockLine { lineNumber?, text, bbox }`;
   `DocparseBlock += lines?, speaker?, lineStart?, lineEnd?`. **Required edit:** the persist
   loop (`ingestion-pipeline.ts:859`) sniffs bbox to derive producer — RR blocks have bboxes
   and would mislabel 'pdf'; carry the producer from the same field that gates the chunker.
5. **Meta View**: fix the now-wrong "expected for RR" empty-state copy; `Lines 8–9 · THE COURT`
   chips; per-line overlay rects labelled with printed numbers; producer header reads `rr`.

## Work items (order matters; #10 is the gate)

| # | Item | Size |
| --- | --- | --- |
| 1 | Pure `reconstructRRLines()` refactor + width/height + viewport | M |
| 2 | Byte-identity test old-vs-new page text over a real volume | S |
| 3 | `rr-block-producer.ts` (turns, lines[], bbox origin conversion) | M |
| 4 | Schema deltas | S |
| 5 | `structureOnly` on BOTH PageText twins | S |
| 6 | `transcriptDoc` in ProduceOptions; RR route; flag all pages | M |
| 7 | Thread pipeline `isRR` into the structure stage | S |
| 8 | Chunker gate `!p.structureOnly` | S |
| 9 | Producer label carried, not bbox-sniffed | S |
| 10 | **Zero-delta golden test**: RR chunk array (text + chunkIndex) identical docparse on/off | M |
| 11 | Block-derived stamping behind comparison logging | M |
| 12 | Promote stamping after review | S — **REJECTED, see below** |
| 13 | Meta View RR display | M |

## Item 12 review outcome (2026-08-06): do NOT promote block-derived stamping

Comparison run on the real 73-page volume: **116 agree / 28 disagree / 0 legacy-only /
0 block-only**. Every disagreement class favors the LEGACY stamp:

1. **Boundary drop** (`1-25` vs `2-25`, several pages): the containment filter requires
   ≥8-char line text, so short boundary lines (a bare "A.  Yes." or shorter) fall out of
   the match set and the block-derived range starts/ends one line in. Legacy reads the
   printed "N  " prefixes directly and keeps them.
2. **Duplicate-text mismatch** (`20-25` vs `2-25`): recurring Q/A text appears on multiple
   printed lines of the same page; naive `chunk.includes(line.text)` matches the FIRST
   occurrence and drags the range to the wrong end of the page. Legacy is position-aware
   by construction.
3. **Overlap bleed**: chunk overlap repeats prior-chunk tails, matching lines the chunk
   only carries as overlap.

Decision: legacy `detectLineNumbers` stays authoritative permanently for stamping; the
comparison logging stays in place (cheap, and will flag any future legacy regression as a
sudden disagree/legacyOnly spike). Block `lineStart/lineEnd` remain valuable for what they
were built for — Meta View display and per-line overlay — not for chunk citation stamps.

## Risks
- Twin-declaration drop (highest) — caught by #10, which must include a volume with
  caption/index pages under the 15-number threshold.
- bbox origin flip — assert line 1 has smallest y0.
- Stamping value drift — comparison rollout only.
- Cost — RR producer must feed off the SAME getTextContent pass as text (no second PDF open).
- Existing RR docs stay empty in Meta View until re-ingested (no backfill path by design).
