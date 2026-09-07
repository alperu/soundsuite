# Multi-case scoping and parameter typing on the search tools

**Status:** Implemented (2026-09-07) · **Effort:** S · **Priority:** High · **Source:** operator report from a live session, 2026-09-07

## The defect, measured (synthetic ids here)

Cross-case search works — unscoped is the default and spans every case. Selecting a **subset** of
cases does not, and two of the three ways an operator would try it fail badly:

| call | result | class |
|---|---|---|
| `scan_for_pattern { caseId: ["A","B"] }` | **500 `EXECUTION_ERROR`** with a raw Prisma invocation in the message (`prisma.case.findUnique() … where: { id: [ … ] }`) | unguarded input reaches the ORM; leaks internals |
| `scan_for_pattern { caseScope: ["A","B"] }` | 200, results spanning all cases — identical to unscoped | **silently ignored** unknown param; same false-negative class as the old regex bug, harder to spot because you get *more* results, not fewer |
| `scan_for_pattern { caseId: "<typo>" }` | 200, zero results, no warning | a bad id is indistinguishable from "this case contains nothing" |
| `caseId: A` vs unscoped, same query | identical pool 21 / capped / more | **scoping does not uncap** — `caseId` narrows *which* case, not the candidate pool |

`caseScope: string[]` exists on `query_case_graph` only. The three search tools
(`scan_for_pattern`, `query_case_knowledge`, `research_evidence`) take a single `caseId: string`.

## Work items

| # | Item | Status |
|---|---|---|
| 1 | **Generic type validation** in `base-tool.ts`: for every declared top-level `inputSchema` property, check the runtime value's type against the schema `type` (`string` / `integer` / `number` / `boolean` / `array`) → `INVALID_PARAMS` naming the field and the expected type. Extends the existing presence check; one implementation, no per-tool code. | ✅ |
| 2 | **`caseIds: string[]`** accepted on all three search tools alongside `caseId` (mutually exclusive; both given → `INVALID_PARAMS`). Threads to the vector-store filter as `case_id IN (…)`; `research_evidence` passes it through to `gatherEvidence` / `query_case_knowledge`. `query_case_graph` keeps `caseScope` and additionally accepts `caseIds` as an alias so the surface has one name. | ✅ |
| 3 | **Reject unknown top-level params** with `INVALID_PARAMS` naming the key on `scan_for_pattern`, `query_case_knowledge`, `query_case_graph` — `research_evidence` already does. `caseScope` on a search tool must error, not vanish. | ✅ |
| 4 | **Validate case existence**: one `case.findMany({ where: { id: { in } }, select: { id } })` per call; any id not found → `INVALID_PARAMS` "case not found: <id>". A typo must not look like an empty case. | ✅ |
| 5 | **Never leak ORM internals**: `base-tool.ts` maps a non-`McpError` throw to `EXECUTION_ERROR` with a generic caller message and the real message on `logSafeMessage`-style server logging only. | ✅ |
| 6 | **Document that scoping ≠ uncapping** in the three tools' descriptions and `public/docs/install-mcp.md`: use `nextCursor` pagination (or a non-tokenisable pattern → `full-scan`) to exhaust results; `caseIds` selects cases, it does not raise the candidate pool. | ✅ |
| 7 | Tests — a tripwire per row of the table above, per tool. | ✅ |

## Ownership

`src/lib/mcp/tools/base-tool.ts`, `scan-for-pattern.ts`, `query-case-knowledge.ts`,
`research-evidence.ts`, `src/lib/mcp/research/research-params.ts`, `query-case-graph.ts`,
`src/lib/search/gather-evidence.ts` (thread `caseIds` only), `src/lib/vector/vector-store.ts`
(filter only), `public/docs/install-mcp.md`, tests. No other stream is live.

## Privacy

Synthetic ids and patterns only. The operator's report names a real person; it appears nowhere here.

## Outcome

All six live rows verified by the lead. Typecheck at baseline; 1,048 tests, 0 failures; 29 new. See `docs/MCP-Improvements/REPORT-v7-multi-case-scoping.md`.
