---
name: draft-record-guard
description: Verifies draft documents are labelled 'draft — filing not confirmed' everywhere they surface (ingestion flag, chunk metadata, citations, prompts, MCP evidence, UI badges) and are never presented as filed record. Use when adding any code path that cites, ranks, or summarises documents.
---

You are auditing the **draft record guard** in Sound Suite (court-lens-mcp).

The user's requirement, verbatim intent: *"When anything is a draft it should say
this is a draft, not sure if it is filed to the record. The system might think a
draft is filed, so when searching the record it should not treat it as a filed
record."*

Your job is to verify — not redesign — that every path which cites, ranks,
summarises or displays documents preserves the `recordStatus` signal and renders
drafts with the visible marker. Report violations with `file:line` and a one-line
fix; do not silently widen scope.

## Invariants

1. **Detection is conservative.** `detectDraftStatus` in
   `src/lib/ingestion/draft-detector.ts` flags `isDraft` only at confidence ≥ 0.6.
   Absence of a court file stamp alone must NEVER mark a draft (it only
   strengthens a positive signal). A present file stamp outweighs filename hints.
2. **Storage is dual, no schema change.** The status lives in
   `Document.tags.recordStatus` (`'filed' | 'draft' | 'unknown'`, plus
   `recordStatusConfidence`, `recordStatusSignals`, `recordStatusSource:
   'auto' | 'manual'`) AND in the LanceDB chunk column `record_status`
   (`'filed' | 'draft' | ''`). `recordStatusSource === 'manual'` is never
   overwritten by ingestion or the backfill.
3. **Every projection carries it.** `ChunkProvenance.recordStatus` is the shared
   field; `pickProvenance` must include it. The projections are: LanceDB row →
   `rowToSearchResult` → `SearchResult.metadata` → `query_case_knowledge` result
   → `DeepSearchSource` (retrieval, pattern, chip-pattern AND RLM source maps) →
   `EvidenceItem` (via `sourceToEvidenceItem`) → AI route inline sources →
   UI `sources[]` types. A new projection that re-lists fields by hand instead of
   spreading `pickProvenance(...)` is a violation.
4. **Citations are marked.** `citeOf()` in `src/lib/search/context-builder.ts`
   renders draft sources as `<cite> — DRAFT, filing not confirmed` (constant
   `DRAFT_CITE_MARKER`). `query_case_knowledge` suffixes `citation` and
   `citationShort` the same way. Any new cite-label builder must call `citeOf`
   or reproduce the marker.
5. **Prompts carry the rule.** `REPORT_SYSTEM_PROMPT`, `OUTLINE_SYSTEM_PROMPT`,
   `SECTION_SYSTEM_PROMPT` in `src/lib/search/deep-search.ts` and
   `EVIDENCE_OUTLINE_SYSTEM_PROMPT` in `src/lib/search/evidence-outline.ts` each
   state: excerpts marked DRAFT are unfiled working copies; never state or imply
   they were filed, ruled on, or are part of the record; cite them as
   "draft (filing not confirmed)". Any new synthesis prompt that receives
   excerpts needs the same rule. `buildOutlineContext` appends
   `DRAFT, filing not confirmed` to the `[E#]` meta of draft evidence.
6. **Filter exists and defaults to no-op.** `query_case_knowledge` accepts
   `recordStatus?: 'filed' | 'draft' | 'any'` (default `'any'`); `'filed'` /
   `'draft'` become `filter.recordStatus`, which `buildWhereClause` turns into
   `record_status = "…"`. Drafts are labelled regardless of the filter.
7. **UI shows an amber badge.** Search results (`src/components/search-interface.tsx`)
   and the filing page document lists
   (`src/app/case-management/[caseNumber]/[filingSlug]/page.tsx`) render
   `DRAFT · filing not confirmed` when `recordStatus === 'draft'`.

## Files to check

- `src/lib/ingestion/draft-detector.ts` — heuristics, threshold, `recordStatusFromTags`
- `src/lib/ingestion/ingestion-pipeline.ts` — `draft-detection` stage after text
  extraction; `chunk.metadata.recordStatus` set in the chunk-enrichment loop
- `src/lib/ingestion/text-chunker.ts` — `ChunkMetadata.recordStatus`
- `src/lib/vector/vector-store.ts` — `record_status` row column, `rowToSearchResult`,
  `buildWhereClause`, `stampRecordStatus`
- `src/lib/search/chunk-provenance.ts` — `ChunkProvenance.recordStatus`, `pickProvenance`
- `src/lib/search/context-builder.ts` — `citeOf`, `DRAFT_CITE_MARKER`
- `src/lib/search/deep-search.ts` — prompts + every `DeepSearchSource` construction
- `src/lib/search/evidence-mapping.ts`, `src/lib/mcp/research-types.ts` — `EvidenceItem.recordStatus`
- `src/lib/search/evidence-outline.ts` — prompt rule + `[E#]` meta
- `src/lib/mcp/tools/query-case-knowledge.ts` — param, schema, filter, result labelling
- `src/app/api/search/ai/route.ts`, `src/components/search-interface.tsx`,
  `src/app/case-management/[caseNumber]/[filingSlug]/page.tsx` — UI projections
- `scripts/backfill-draft-status.ts` — backfill (dry-run default, `--apply` writes)

## Grep commands

```bash
# Every projection that lists structure fields must also list recordStatus
grep -rn 'tableMarkdown' src --include='*.ts' --include='*.tsx' | grep -v __tests__ | grep -v recordStatus
# Hand-built DeepSearchSource literals that skip pickProvenance
grep -n 'filingSlug: r.filingSlug' src/lib/search/deep-search.ts
grep -n 'pickProvenance(r)' src/lib/search/deep-search.ts     # counts must match
# Prompts that receive excerpts but lack the draft rule
grep -n 'SYSTEM_PROMPT = `' src/lib/search/deep-search.ts src/lib/search/evidence-outline.ts
grep -n 'DRAFT, filing not confirmed' src/lib/search/deep-search.ts src/lib/search/evidence-outline.ts
# Citation builders that bypass citeOf
grep -rn 'citationShort ||' src --include='*.ts' --include='*.tsx' | grep -v __tests__
# Where-clause + filter param wiring
grep -n 'record_status' src/lib/vector/vector-store.ts
grep -n 'recordStatus' src/lib/mcp/tools/query-case-knowledge.ts
# Tests
npx jest src/lib/ingestion/__tests__/draft-detector.test.ts src/lib/search/__tests__/context-builder.test.ts src/lib/search/__tests__/draft-record-guard.test.ts src/lib/mcp/tools/__tests__/query-case-knowledge-draft.test.ts --no-coverage
```

## Synthetic fixture

Never use real case data. Use this shape (invented names, placeholder cause number):

```
DRAFT
CAUSE NO. 00-0000-XX
JANE ROE, Petitioner  v.  JOHN DOE, Respondent
IN THE DISTRICT COURT, 000TH JUDICIAL DISTRICT, EXAMPLE COUNTY, TEXAS
MOTION FOR CONTINUANCE
… body …
Dated: ____________          ______________________________  JUDGE PRESIDING
[INSERT ATTORNEY NAME]
```

Expected: `detectDraftStatus({ fileName: 'motion-draft-v2.pdf', firstPagesText, lastPagesText })`
→ `recordStatus: 'draft'`. The same text prefixed with
`Filed 3/14/2024 9:02 AM / Pat Example, District Clerk / Envelope No. 12345678`
and without the DRAFT line → `'filed'`. Neither stamp nor draft signal → `'unknown'`
(never `'draft'`).

## Report format

- Invariant checked → PASS / FAIL with `file:line`
- For each FAIL: the missing field / rule / marker and the one-line fix
- Test results of the jest command above
