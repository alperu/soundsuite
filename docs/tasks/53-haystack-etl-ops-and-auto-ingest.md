# Task 53 — Haystack vendor ops, MCP bridge, and model-driven auto-ingestion

**Date:** 2026-09-19 · **Status:** shipped (phases 1–3 of the plan, plus auto-ingestion);
phase 4 (worklist confirm op) open
**Plan:** [`../PLAN-haystack-mcp-agentic-etl.md`](../PLAN-haystack-mcp-agentic-etl.md)
**Skill:** `skills/soundsuite-etl/SKILL.md`

No case names, docket numbers, party names or file names appear in this document.

## What was asked

1. The plan's ETL loop over custom Haystack ops, bridged to MCP (plan §4–§6).
2. *"Haystack Auto Ingestion"*: give a path; the model (OpenRouter DeepSeek Flash 4.1) reads the
   PDFs — **first two pages only** — and answers **what** each filing is, **who** filed it and
   **when** (from the clerk's file stamp), suggests what to ingest and how to map it, tidies
   the folder into per-kind subfolders, and queues ingestion.
3. A dashboard page **Haystack Management** with a sub-page **Haystack ETL**, in the left nav
   with an icon matching the rest.

## What shipped

### The op layer — `src/lib/haystack/ops/`

| File | Holds |
|---|---|
| `catalogue.ts` | `VENDOR_OPS`: name, doc, `exposure` (`read` / `write` / `llm`), `params`. The one description every surface derives from. `STANDARD_OP_PARAMS` describes the standard ops the same way. |
| `index.ts` | `runVendorOp(op, rawParams, { actor, trusted, llmContext })`: coerces params against the catalogue (query strings arrive as strings; unknown keys are rejected), enforces the write gate, dispatches. `writesEnabled()` reads `SS_HAYSTACK_WRITE`. |
| `types.ts` | `OpResult { meta, rows }`, `OpActor`, `OpError`, `provenanceTag()`. |
| `scope-graph.ts` | `ssScopeGraph` — summary per case, or one case drilled to filings. |
| `worklist.ts` | `ssWorklist` — adapter over `lib/scope/worklist.ts`. |
| `folder-survey.ts` | `ssFolderSurvey` — disk vs database by path then SHA-256; nested-case detection. |
| `ingest-status.ts` | `ssIngestStatus` — status counts per case; errored rows for one case. |
| `read-case.ts` | `ssReadCase` — the §6.4 grid: meta is the case truth, rows are documents. |
| `case-ensure.ts` | `ssCaseEnsure` — find-or-create through `commitEntity`, idempotent on path then caseNumber. |
| `promote.ts` | `ssPromoteDiscovered`, `ssRequeueErrored` — adapters over `lib/ingestion/promotion.ts`. |
| `auto-ingest.ts` | `ssAutoIngestPlan` / `ssAutoIngestApply`. |
| `fs-walk.ts` | bounded PDF walk, streamed SHA-256. |

**The lifted worklist** — `src/lib/scope/worklist.ts`: `definingSlotEmptyFilings(graph)` is the one
definition of the queue; the browser workbench (`pairing-workbench.tsx`) now calls it too.
`src/lib/scope/scope-graph-data.ts` is the `/api/scope/graph` loader, shared with the ops and
narrowable to one case.

### The wiring

- `src/app/api/haystack/[op]/route.ts`: vendor ops are registered from the catalogue; `opOps()`
  emits `params`, `doc` and `ssExposure` per row (plan §6.1); `opVendor()` adapts query/body →
  `runVendorOp` → grid, and passes `trusted = skipAuth` so the same-origin proxy is exempt from the
  write gate while the bearer API and MCP are not.
- `src/lib/mcp/tools/haystack-ops.ts`: one `BaseMCPTool` per catalogued op, named as the op.
  `read` → both profiles, `category: 'search'`. `write` / `llm` → `profiles: ['routed']`. A
  `dryRun: false` write from MCP without `SS_HAYSTACK_WRITE=1` is `POLICY_VIOLATION`.
- `src/lib/haystack-client/index.ts`: `op(name, params)` for the dashboard.

### Auto-ingestion

`ssAutoIngestPlan({ path, model?, maxFiles?, sampleForCase?, excerptChars? })`:

1. Walks the folder; reconciles each PDF against Document rows by path, then hash.
2. Reads **two pages** per file (`quickExtractHeader(path, 2)`), runs the regex detector beside it.
3. One model call for the case identity over a sample — cause number, court, parties, the caption
   quote as evidence; **disagreement between sampled files is reported, never resolved**.
4. One model call per batch of 8 files: `filingType` (canonical), `title`, **`filedBy`** (side),
   **`author`**, **`filedOn` from the clerk's stamp only**, `signedOn` separately, `stampEvidence`,
   `confidence`, `evidence`, `answersTitle`. Values outside the vocabulary become `Other` /
   `unknown` / `null` — never a guess.
5. Resolves `answersTitle` to a motion in the plan deterministically (title-token overlap with a
   margin), else `answersPath: null`.
6. Proposes `targetDir` per file (`Motions`, `Notices`, `Responses`, `Replies`, `Orders`, `Records`,
   …). Writes nothing, moves nothing.

`ssAutoIngestApply({ plan, organize?, queue?, dryRun })`, idempotent per step: Case found by path or
created via `commitEntity` (with `ssProvenance`); optional move into `targetDir` with the Document
row re-pathed *before* the watcher sees the rename; Filing found by slug or created (with
`filingDate` from the stamp); entity row through `ensure-filing` (never a raw create — plan §8.5);
`filedOn` / `signedOn` written as real spec tags and `filedBy` / `author` / `stampEvidence` under one
namespaced `ssEtl` tag; Document attached by hash (or path) or created, `DISCOVERED → QUEUED`; links
(`respondingTo` / `replyingTo` / `resolves` / `motionRef`, the last with its `motionId` column) only
where the target resolved in this run. **Apply never re-runs the model.**

### The pages

- `/haystack-management` — cards (ETL, block-view editor, scope), per-case table with the real
  `unconnected` count, the live op catalogue with exposure badges.
- `/haystack-management/etl` — `components/haystack-etl/etl-panel.tsx`: path + model + cap → plan;
  case identity card with disagreement banner; editable file table (type, title, filed-by, stamp
  date, answers, folder, confidence, evidence, detector disagreement); organise / queue switches;
  dry run → armed apply (inline confirm, no browser dialog).
- Nav: **Haystack Management** → `/haystack-management`; sub-item **Haystack ETL** with its own
  icon, same `text-sm font-medium` as every other entry, icon-only when collapsed.

### Tests

`lib/haystack/ops/__tests__/{spec-and-adapter,folder-survey,auto-ingest}.test.ts`,
`lib/scope/__tests__/worklist.test.ts`, `lib/mcp/tools/__tests__/haystack-ops.test.ts`,
`app/api/haystack/__tests__/vendor-ops.test.ts`. All synthetic. The model, the PDF reader and the
write helpers are mocked in the auto-ingest suite; the folder is a temp dir.

## Decisions worth knowing

- **`ssIngestStatus` kept as its own op** even though `ssReadCase.meta` carries the same counts for
  one case: the corpus-wide view (one row per case) is what the survey step wants first.
- **`unconnected` is real** in `ssScopeGraph` / `ssReadCase`: it is the defining-slot-empty count
  from the lifted worklist, not the any-ref-empty definition of `/api/scope/unconnected`.
- **Two pages, not five**, for the planner: caption, file stamp and signature block live there;
  the rest is argument the planner pays for and does not use. `quickExtractHeader` gained a
  `maxPages` argument for this; its default (5) is unchanged for the detector.
- **Signature date ≠ filing date.** `filedOn` comes only from a clerk's stamp; a file with no stamp
  on page 1–2 gets `filedOn: null` and a warning, not the signature date.
- **Vocabulary is closed.** `filingType` must be one of `FILING_TYPES`; `filedBy` one of eight
  sides; anything else degrades to `Other` / `unknown`. The apply validates the plan again.
- **Names the model reads are not slots.** `filedBy` / `author` go under `ssEtl` so no invented
  key lands in the open tag bag beside `movantRef` and friends (plan §8, "the tag bag is open").

## Open

- **Phase 4 — `ssLinkConfirm`**: write one worklist suggestion (exact accepted values, provenance,
  refuse when the slot holds a human value). The apply already writes evidenced links; the
  worklist rows still need a confirm op for the rest.
- **`ssLinkPropose` with the model** for rows the deterministic suggester cannot answer.
- **Person resolution** from `author`: `ssEtl.author` is text; turning it into a `Person` +
  `PersonRole` belongs with the persona extractor's propose-then-confirm path.
- **Long-running plan calls**: `ssAutoIngestPlan` is synchronous; a 400-file folder is minutes.
  The job-handle convention (plan §13.2) is still undecided.
- **CLAUDE.md / AGENTS.md** already describe `DISCOVERED` correctly; nothing to fix there.
