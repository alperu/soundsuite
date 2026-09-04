# MCP Report v3.1 — verification, fixes, and the draft-record guard

**Date:** 2026-09-04 · **Baseline:** `59a9236` (two-profile split) · **Source report:** `REPORT-v3-two-profiles-verification-and-gaps.md`

All examples in this document are synthetic. No case numbers, party names, filing titles, or
document text from the corpus appear here — only opaque document ids where a count was needed.

## Summary

Every item in v3 except **M-1's live verification** and **M-5 (security)** is closed. A separate
workstream — the **draft-record guard** — was implemented in the same round and is verified at the
code level; its *runtime* guarantee does not hold until an operator runs the backfill (below).

| Item | Status |
|---|---|
| M-1 · local pipeline hangs in decompose | Code landed; **live verification not completed** |
| M-2 · proxy not reloaded; profile filtering | ✅ Fixed and verified live |
| M-3 · routed defaults to Ollama/multiPass | ✅ Fixed and verified live |
| M-4 · proxy progress relay | ✅ Verified in the restarted proxy |
| M-5 · security (v2 §6) | ⛔ **Open — unchanged.** Not attempted this round |
| M-6a · router regex matches bare `report`/`brief` | ✅ Tightened |
| M-6b · 12 analysis tools with zero executions (SS-3) | ⚠️ Partial — see below |
| M-6c · pre-existing test/type failures | ✅ Fixed |
| M-6d · `phaseStartedAt` missing | ✅ Added |
| M-6e · bridge `logging` capability unverified | ✅ Verified in `initialize` |
| Task 07 · local MCP servers panel | Operator step — not automatable |
| — · draft-record guard | ✅ Implemented; **backfill not applied** |

## Verification evidence

**Typecheck.** `npx tsc --noEmit` reports **59 errors in 15 files**, against **65 in 16 files** at
`HEAD`. The difference is exactly the 6 errors in the `runStream` block of `deep-search.ts` that
M-6c fixed. Every remaining error file is byte-identical to its baseline set — pre-existing Prisma
mock typings and `worker-init.ts` client-extension variance. **No new type errors.**

**Tests.**

| Scope | Result |
|---|---|
| `src/lib/mcp`, `src/lib/search`, `src/app/api/mcp` | **456 pass, 0 fail** |
| `src/lib/search` + the two draft suites (after the prompt fix) | **320 pass, 0 fail** |
| `src/lib/ingestion` | 420 pass / **63 fail** — identical failure count to `HEAD` (409/63); pre-existing poppler + fixture failures, +11 new passing tests |

**Lint.** The touched files are clean. `search-interface.tsx` reports 4 errors / 3 warnings, which
is byte-identical to the same file at `HEAD` (`react-hooks/exhaustive-deps` ×3,
`@next/next/no-html-link-for-pages` ×2, `react/no-unescaped-entities` ×2) — pre-existing.

## M-1 — decompose hang (live verification not completed)

The fixes are in the tree: a `decomposeTimeoutMs` retrieval setting, a heuristic-decompose fallback
(`src/lib/search/heuristic-decompose.ts`, tested), an Ollama readiness smoke test in
`shared-dependencies.ts`, an explicit `localDecomposeModel`, and `phaseStartedAt` so a stalled phase
is visible rather than silent.

What could not be closed is the **live** `research_evidence mode:deep` run. The blocker is
environmental, not code:

- `ai.ollamaCompletionHost` (`192.168.88.249:11434`) is healthy — a 5-token `qwen3.5:9b` generate
  returns in **0.9 s**, and both models are resident, so there is no model thrash there.
- `embedding.ollamaHost` (`10.10.20.5:11434`) **times out on `/api/tags` entirely.** It is
  unreachable from this host.

A deep run needs the embedding host. Until it answers, a live timing number would measure the dead
host, not the fix. **Recommended operator step:** bring `10.10.20.5` back or repoint
`embedding.ollamaHost`, then run one `research_evidence mode:deep` and confirm the phase advances
past `decompose` within `decomposeTimeoutMs`.

## M-6b — analysis tools with no execution history

The 12 analysis tools now carry correct profile metadata and are hidden when Ollama is down, which
was the reported symptom. **Per-tool execution tests were not written.** They remain the largest
untested surface in the MCP layer.

## M-5 — security

Deliberately untouched. `routed` still must not be reachable remotely without auth: it spends API
credit and sends case text to third parties on request. This is unchanged from v2 §6 and should be
scheduled on its own.

## The draft-record guard

**Problem.** A draft is an unfiled working copy. Retrieval treated it exactly like a filed
document, so a synthesised answer could assert that a party filed something, or that a court ruled
on it, on the strength of a document that never reached the clerk.

**Design.** No schema migration. `recordStatus` (`filed` | `draft` | `unknown`, plus confidence,
signals, and source) rides on `Document.tags`, and a `record_status` column on the LanceDB chunk
rows. `VectorStore.ensureRecordStatusColumn` adds that column to tables that predate it, defaulting
old rows to `''`, so pre-existing indexes are not orphaned.

The guard is applied at every point where a document surfaces:

| Layer | Behaviour |
|---|---|
| Ingestion | `detectDraftStatus` runs as a pipeline stage; result is written to tags + chunk rows |
| Citations | `citeOf` renders a draft as `<cite> — DRAFT, filing not confirmed` |
| Prompts | Synthesis, outline, and section prompts forbid asserting filed status |
| MCP evidence | `EvidenceItem.recordStatus`; the outline context labels drafts inline |
| `query_case_knowledge` | `recordStatus: 'filed' \| 'draft' \| 'any'` filter |
| UI | Amber badge on search results and the filing page |

**Detector conservatism.** Absence of a file stamp never marks a draft on its own — it only
strengthens an existing signal — and a present file stamp actively counters draft language, so a
filed motion that discusses a "draft order" stays `filed`. `isDraft` requires confidence ≥ 0.6.

**Filter semantics** (worth knowing before you rely on it):

- `recordStatus: 'filed'` compiles to `record_status = "filed"` — strict. It excludes unknown and
  never-backfilled rows. Safe direction (it will not pass off an unknown as record) but it is a
  *narrowing* filter, not a "hide drafts" filter.
- No filter compiles to `record_status != "draft"` — unknowns come back, drafts do not.

**The `unknown` gap, and the fix.** The detector classifies most of the corpus `unknown`
(29 filed / 2 draft / 65 unknown across 96 documents). The prompt rules initially covered only
excerpts marked DRAFT, which left the model free to assert filing status for an `unknown` document —
the exact failure the guard exists to prevent, on 68% of the corpus. All four prompt blocks
(`deep-search.ts` synthesis, outline, and section prompts; `evidence-outline.ts`) now also state
that filing status is confirmed only where an excerpt says so, and that an unmarked excerpt must
never be described as filed, served, or ruled on.

**`recordStatusConfidence` is a draft-score, not a status confidence.** A `filed` document scores
`0.00` because nothing argued it was a draft. The field is write-only — nothing reads it to make a
decision — and the backfill printout now labels it `draftConf` so it cannot be misread.

### ⚠️ The guard is not yet in effect on existing data

`detectDraftStatus` runs on *newly ingested* documents. Every document indexed before this change
still has no `recordStatus`, so **0 documents currently carry the flag**. The code path exists; the
guarantee does not hold until the backfill runs.

Current dry run over 96 documents:

```
Tally: { filed: 29, draft: 2, unknown: 65 }
Changed: 31   manual (kept): 0   no text: 0
DRY RUN — pass --apply to write Document.tags and stamp chunk rows.
```

```bash
npx tsx scripts/backfill-draft-status.ts            # dry run (default)
npx tsx scripts/backfill-draft-status.ts --apply    # write tags + stamp chunk rows
```

Run it **without** a `DATABASE_URL` override — the CLI default resolves to the stale root-level DB.
Documents whose tags carry `recordStatusSource: 'manual'` are never overwritten, so an operator
correction survives re-runs.

## Operator follow-ups

1. **Apply the backfill** — `--apply`. Until then no existing document is flagged.
2. **Embedding host `10.10.20.5:11434` is unreachable.** M-1's live verification is blocked on it.
3. **Re-register remaining MCP clients.** The legacy `/sound-suite/mcp` path is gone; the two
   upstreams are `/sound-suite-local/mcp` and `/sound-suite-routed/mcp`. `~/.claude.json` is
   already migrated (backup kept alongside it).
4. **mcp-proxy commit `d36c0a1` is local and unpushed** in `~/Code/mcp-proxy`.
5. **The `default` preset is memoised per process** — editing it requires a dev-server restart.
6. **M-5 security and M-6b per-tool tests** are open work, not oversights.
