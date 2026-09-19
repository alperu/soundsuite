---
name: soundsuite-etl
description: "Ingest a folder of court PDFs into Sound Suite through its Haystack ops: survey the folder, identify the case, classify each filing (what / who / when), link responses to motions, tidy the folder, queue ingestion, then work the judgment queue. Use when asked to ingest, register, map or connect a case folder."
---

# Ingesting a folder into Sound Suite

Sound Suite exposes its case graph as **Haystack ops** — `ss*` ops on the Haystack server,
bridged one-to-one as MCP tools with the same names. This skill is the *procedure*; the ops
are the *primitives*. Every branch of the loop lives here, in prose, so it can be corrected
without a deploy. (Design: `docs/PLAN-haystack-mcp-agentic-etl.md`.)

**"Ingest this folder" is many turns, not one call.** Say so up front, report per stage, and
stop at the review gate. The operator asked for an ETL run, not for unattended writes to
litigation records.

## -1. Which profile

Sound Suite runs one **data profile** at a time (`profile_list` shows them, with their cases;
`profile_use(name)` switches the whole server). Every result carries `profile`. When the operator
names a profile ("ingest this into Demo"), call `profile_list`, switch if needed, and pass
`expectProfile: "<name>"` on the calls that follow so a wrong-profile call is refused instead of
answered.

## 0. What you can and cannot do

| Tool | Profile | Writes? |
|---|---|---|
| `ssScopeGraph`, `ssWorklist`, `ssFolderSurvey`, `ssIngestStatus`, `ssReadCase` | local + routed | never |
| `ssCaseEnsure`, `ssPromoteDiscovered`, `ssRequeueErrored`, `ssAutoIngestApply` | routed only | only with `dryRun: false`, and only if the server runs with `SS_HAYSTACK_WRITE=1` |
| `ssAutoIngestPlan` | routed only | never — it reads PDFs and calls the model (OpenRouter, `deepseek/deepseek-v4.1-flash`) |

Every `dryRun` defaults to **true**. Run the dry run, show the operator the plan, then apply
the *same* plan. Apply never re-runs the model: what was reviewed is what is written.

If a write is refused with `POLICY_VIOLATION` mentioning `SS_HAYSTACK_WRITE`, do not work
around it. Tell the operator the dashboard page **Haystack Management → Haystack ETL** can
apply the same plan (the person at the keyboard is the review gate), or that the server can be
started with the switch on.

Every result is `{ meta, rows }`. **Meta counts are for the whole set; rows page.** Read meta
to decide whether to look further.

## 1. The loop

```
1 SURVEY     ssScopeGraph()                     which cases exist, unconnected counts
             ssFolderSurvey(caseId)             disk vs database: new / moved / orphaned / ignored,
                                                nested case folders
2 IDENTIFY   ssAutoIngestPlan(path)             case identity from the captions; per file: what /
   + PLAN                                       who / when; links by title; target folders
3 REVIEW     — show the plan —                  drop low-confidence rows, fix types/titles
4 APPLY      ssAutoIngestApply(plan, dryRun)    case, folders, filings, entities, documents, links
5 INGEST     ssPromoteDiscovered / ssIngestStatus   DISCOVERED → QUEUED; poll; ERROR is terminal
             ssRequeueErrored(limit)            the capped way back in
6 LINK       ssWorklist(caseId)                 filings whose defining link is still empty,
                                                with the deterministic suggestion
```

### Step 1 — survey before anything else

`ssScopeGraph()` with no arguments. If the folder is already a case, `ssFolderSurvey(caseId)`.
Read `meta`: `new` means files the database has never seen; `orphaned` means rows whose file is
gone; `nestedCases` non-empty means another case is registered *inside* this folder — the
watcher attributes by first prefix match, so say so before doing anything.

`ssIngestStatus()` shows the bucket nobody expects: **`discovered`** is discovered-and-never-
processed, not ingested. A case with hundreds there has an ingestion problem, not a linking
problem. Report that number first.

### Step 2 — plan

`ssAutoIngestPlan({ path })`. It reads the **first two pages** of each PDF and returns
`rows[0].plan`. Read:

- `plan.case` — cause number, court, parties, `confidence`, `evidence` (the caption quote).
  `disagreement` non-empty means sampled files carry different cause numbers: the folder may
  hold more than one case. **Stop and ask.** Do not pick one.
- `plan.files[]` — per file: `filingType`, `title`, `kind`; **who**: `filedBy` (side) and
  `author`; **when**: `filedOn` from the *clerk's file stamp* (`stampEvidence` is the verbatim
  line), `signedOn` separately. `filedOn: null` means no stamp on the first two pages — a
  signature date is *not* a filing date, and the plan does not pretend otherwise.
  `disagreesWithDetector` means the regex detector read the type differently; both are shown.
  `answersTitle` / `answersPath` for responses, replies and orders.
- `plan.warnings[]` — read every one aloud to the operator.

Cost: one model call per ~8 files plus one for the identity. Say this before calling it on a
large folder; `maxFiles` (default 60) bounds a run.

### Step 3 — review, honestly

Set `accepted: false` on any row you would not defend. A `low` confidence row with no
evidence is a question, not a fact. **Never fill a slot you cannot evidence** — a blank with a
reason is a result; a guess is a defect that later gets cited.

### Step 4 — apply, twice

`ssAutoIngestApply({ plan, organize, queue })` — dry run first. Every row reports what it
*would* do: `filingAction`, `documentAction`, `linkAction`, `movedTo`. Show it. Then the same
call with `dryRun: false`. `organize: true` moves each file into its per-kind subfolder and
updates the Document row's path so the watcher sees a rename, not a new file. Links are
written only where the target resolved to a filing created or found in this run.

### Step 5 — ingest and watch

`ssPromoteDiscovered({ caseId, limit })` — `limit` is required, there is no whole-backlog call.
Poll `ssIngestStatus({ caseId })`. `ERROR` is terminal (the worker has no retry);
`ssRequeueErrored({ caseId, limit })` is the capped way back in — never uncapped, because an
OCR-not-ready failure pauses every worker.

### Step 6 — the judgment queue

`ssWorklist({ caseId })`. Each row is a filing whose defining slot is empty. `suggestion` is the
deterministic pick (same case, filed after, shared title words) with `reasons` and `margin`;
`suggestion: null` carries `noCandidateReason`. Motions never appear — they are roots.

Writing a link from the worklist is **not yet an op** (phase 4 of the plan). Report the rows;
the operator confirms them in the block-view editor, or the ETL apply already wrote the ones it
could evidence.

## 2. Stop conditions

- **Good:** `ssWorklist` empty, `ssIngestStatus` shows no `discovered` and no `errored`,
  `ssFolderSurvey` shows no `new`.
- **Bad:** a worklist that stops shrinking across two passes — something needs a human.
- **Always:** a `disagreement` in the case identity, or a `nestedCases` finding. Ask.

## 3. Privacy

Plan output contains real captions, party names and cause numbers. It stays in the
conversation and in the database. Never write it to a file in the repository, a task
document, or a commit message.
