# MCP discovery tools — making the surface callable without prior knowledge

**Status:** Implemented (2026-09-07) · **Effort:** M · **Priority:** High · **Source:** `docs/MCP-Improvements/MCP-discovery-tools.md`

Every scoped tool requires a UUID and the MCP surface hands out almost none of them. Retrieval
returns the *docket number* (`caseNumber`); the tools want the *database id* (`caseId`); nothing
maps between them. The SS-3 #1 fix (missing `caseId` → `INVALID_PARAMS`) was correct — a false
positive outranks a missing answer — but it turned a silent wrong result into a hard block with no
supported way to obtain the argument. Four tools are unreachable from a clean session;
`query_case_graph` (all three operations) always was — its zero executions mean "cannot be called",
not "untested".

## Work items (build order from the source doc §7)

| # | Item | Size | Status |
|---|---|---|---|
| 1 | **`caseId` (+ `motionId` where resolvable) on `EvidenceItem` and `query_case_knowledge` results** | XS | ✅ row column, never projected; via `ChunkProvenance` so deep-search needed no edits; `motionId` batched |
| 2 | `list_cases` | S | ✅ |
| 3 | `list_motions` (with `hasAmendments`) | S | ✅ (corpus has no amendment links — data, not code) |
| 4 | `resolve_reference` — ranked candidates, `matchedOn`, `ambiguous` flag, never collapses to one | M | ✅ max-across-fields scoring (a `??` chain inversion was caught and fixed) |
| 5 | `list_people` (with `role`, `motionCount`) | S | ✅ (no Person↔Motion links in corpus — data, not code) |
| 6 | Gate `GET /api/cases` — outside the `/api/mcp/*` guard | XS | ✅ GET + POST, task 09 A |

## Design rules (binding)

- All four tools: **`local` profile**, no LLM, single indexed query, compact rows. `verb_noun` naming.
- **`resolve_reference` never returns a single answer.** Candidates carry `matchedOn` and
  `confidence`; `ambiguous: true` when the top two are within ~0.15. A discovery tool that silently
  picks the wrong case reintroduces the exact false-positive class SS-3 #1 eliminated.
- Item 1 first: it makes items 2–5 optimisations rather than prerequisites.
- Every tool exercised by the SS-3 test pattern — a tripwire asserting the id actually resolves,
  paired with one asserting the ambiguous case is *reported*, not resolved.

## Ownership (parallel streams active — task 09 A/B are live)

**C (this task)** owns: new files `src/lib/mcp/tools/list-cases.ts`, `list-motions.ts`,
`list-people.ts`, `resolve-reference.ts`; `src/lib/mcp/tools/index.ts` (registration);
`src/lib/mcp/research-types.ts` and `src/lib/search/evidence-mapping.ts` (add `caseId`/`motionId`);
`src/lib/mcp/tools/query-case-knowledge.ts` (projection only); `src/lib/vector/vector-store.ts`
**only if** the chunk row needs a projected column; tests under
`src/lib/mcp/tools/__tests__/discovery-*.test.ts` and `src/lib/search/__tests__/evidence-mapping.test.ts`.

**Not C's:** `src/app/api/**` (task 09 A), the 10 LLM tool files and `ai-helper.ts` / `base-tool.ts`
(task 09 B), `gather-evidence.ts`, `routing-defaults.ts`, the bridge.

## Privacy

Synthetic fixtures only. The source doc reproduces no case identifiers; keep it that way. Live probes
may return real case names and docket numbers — classify by shape, never paste them.

## Outcome

Local profile 20 → 24 tools. 40/40 evidence items carry `caseId`; 17/40 `motionId`. `query_case_graph` callable for the first time. See `docs/MCP-Improvements/REPORT-v6.1-surface-guard-and-discovery.md`.
