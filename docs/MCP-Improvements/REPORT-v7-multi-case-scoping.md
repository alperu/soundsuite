# MCP Report v7 — multi-case scoping and parameter typing

**Date:** 2026-09-07 · **Baseline:** `d2a4665` · **Task doc:** `docs/tasks/12-multi-case-scoping-and-param-typing.md`
**Source:** an operator's live session report, 2026-09-07

All ids and patterns synthetic. No case names, docket numbers, or person names.

## What was wrong

Cross-case search already worked — unscoped is the default and spans every case. Selecting a
**subset** of cases did not, and two of the three ways an operator would try it failed badly:

| call | before | after |
|---|---|---|
| `caseId: ["A","B"]` | **500** with a raw Prisma invocation in the message | **400** `INVALID_PARAMS` — "caseId must be a string, received array"; no store or DB call made |
| `caseScope: ["A","B"]` on a search tool | 200, **silently ignored** — results from every case | **400** — "unknown parameter: caseScope — use caseIds on this tool. Accepted parameters: …" |
| `caseIds: ["A","B"]` | (did not exist) | 200, results whose `caseId` values are exactly a subset of {A, B} |
| `caseId` + `caseIds` | — | 400 — "mutually exclusive — send caseId for one case or caseIds for a subset" |
| `caseId: "<typo>"` | 200, zero results, no warning | **400** — "case not found: <id> — call list_cases for valid caseId values" |
| `patern: "…"` | presence error on `pattern` | 400 — "unknown parameter: patern. Accepted parameters: …" |

All rows verified live by the lead against the running instance, not only by the implementing agent.

## Root causes, and why the fix is mostly generic

**The 500 was two bugs stacked.** The SS-3 pass added a *presence* check derived from each tool's
`inputSchema.required`, but no *type* check — so an array where a string was declared reached
`prisma.case.findUnique({ where: { id: [...] } })`, which threw; and the catch forwarded the ORM's
own message to the client. Both are fixed once, in `base-tool.ts`, for every tool:

- **`validateParamTypes`** checks each *declared* top-level property's runtime type against its
  schema `type` (`string` / `integer` / `number` / `boolean` / `array`). It inspects only declared
  properties, so it cannot break an under-declared schema.
- **A caller-safe error-code allowlist**: any non-`McpError` throw becomes `EXECUTION_ERROR` with a
  generic caller message; the real error is logged server-side through the existing redacted-log
  path. A Prisma invocation string can never reach an MCP client again, from any tool.

**Validation order** is now `validateKnownParams` (unknown keys) → `validateRequiredParams`
(presence) → `validateParamTypes` (types) → the per-tool `validateParams()` hook. Unknown-first is
deliberate: a typo'd key is usually the *cause* of the presence failure, so
`unknown parameter "patern"` beats `pattern is required`. Unknown-key rejection is **opt-in per
tool** (`rejectsUnknownParams()`), switched on for `scan_for_pattern`, `query_case_knowledge`, and
`query_case_graph` — `research_evidence` already did it. To turn it on safely, every internal caller
was audited and the params they pass but the schema never declared (`whereClauses` on
`scan_for_pattern`; `mode`, `softBoostRefs` on `query_case_knowledge`) were **declared** rather than
broken. One dead param (`chatId`, which `scan_for_pattern` never read) was dropped from the
`/api/search/ai` caller.

**Scoping** lives in one shared module, `src/lib/mcp/case-scope.ts` — `resolveCaseScope`
(mutual exclusion + normalisation), `assertCasesExist` (one `case.findMany({ where: { id: { in } } })`
per call regardless of list size), `caseScopeFilter` — used by all four tools so the rules cannot
drift. `buildWhereClause` in the vector store emits `case_id IN ("…", "…")`, with the same quoting
as the single-id form and `IN` even for one element so the shape is stable; `scanTextColumn`
(last round's full-scan path) shares it, so the regex fallback is scoped identically. On
`research_evidence` the scope is validated **before** job promotion, so a bad id fails fast
instead of after a 60-second job. `query_case_graph` keeps `caseScope` and accepts `caseIds` as an
alias (both together → error), so the surface has one name.

## The correction that matters for a re-run: scoping ≠ uncapping

Measured before this round: `caseId: A` and unscoped returned the **identical** candidate pool
(21, capped, more available). `caseId` narrows *which* case, not how many candidates the keyword
pass considers. So re-running a capped search scoped to one case does not recover the matches that
were capped. To exhaust results: use `nextCursor` pagination, or a non-tokenisable pattern to force
`full-scan`. And **filtering an unscoped scan client-side is not equivalent** — the cap bites before
the filter runs, so matches from the cases you care about are silently lost.

The exhaustive multi-case pattern is now documented in the three tools' descriptions and in a
"Searching a subset of cases" section of `public/docs/install-mcp.md`: `list_cases` → `caseIds`
→ page to exhaustion per case → merge.

## Verification

- **Typecheck:** 59 errors in 15 files — byte-identical to the baseline.
- **Tests:** mcp + search + vector + api-mcp + api-search → **1,048 passed, 0 failed** (54 suites);
  29 new in `case-scoping.test.ts` plus tripwires added to the scan-regex, qck, and
  gather-evidence suites (full-scan honours `caseIds`; `caseIds` threads through all three
  retrieval arms and the RLM rounds).
- **Lint:** clean on every changed source file. **Privacy scan:** clean.

## Also in passing

- The embedding failure in `query_case_knowledge` is now coded `EMBEDDING_UNAVAILABLE`, and the
  vector store's dimension mismatch carries `EMBEDDING_DIMENSION_MISMATCH`; the dashboard search
  routes branch on `errorCode` instead of parsing message text.

## Still open

- Unknown-key rejection is opt-in; the 10 LLM analysis tools and the discovery tools have not been
  switched on. Each needs the same internal-caller audit first.
- The candidate-pool cap itself (`limit × 5` on the FTS path) is unchanged — pagination is the
  supported route to exhaustion.
