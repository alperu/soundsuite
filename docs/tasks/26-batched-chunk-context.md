# Batched `get_chunk_context({ chunkIds })` — collapse N × 6 probes into one pass

**Status:** Proposed — **diagnosed, not verified** · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §3a, §6 item 5

> **Provenance.** The code citations below were read from source. The *design* is derived from v12,
> which was written from the caller's side without reading the code — and four of its premises were
> subsequently found wrong. Nothing here has been executed. Confirm the measurements before building.

Field names, counts and code citations only. No case data.

## Problem

`get_chunk_context` takes one `chunkId`. Padding twenty scan hits means twenty calls. v12 identified
this as the biggest round-trip win and correctly said to build the batched form **first**, so a naive
per-hit loop never gets baked in.

**v12 undercounts the cost per call.** It says three probe queries. The floor is **4** and the typical
case is **6** (`src/lib/mcp/tools/get-chunk-context.ts`):

| Probe | Line | Purpose |
|---|---|---|
| target row fetch | `:266-269` | `id = "<chunkId>"`, limit 2 — yields `documentId`, `targetIndex`, `isExhibit`, `exhibitPath` |
| `prevProbe` | `:309-312` | `chunk_index < targetIndex`, limit 1 — existence test for `atDocumentStart` |
| `nextProbe` | `:313-316` | `chunk_index > targetIndex`, limit 1 — existence test for `atDocumentEnd` |
| `collectSide('before')` | `:357-360` | 1–8 scans fetching the actual window rows |
| `collectSide('after')` | `:357-360` | 1–8 scans |
| `twinRows` | `:427-430` | `chunk_index = targetIndex`, limit 8 — ordering-ambiguity check |

So twenty hits is **80–120 store operations**, not 60.

## The blocker v12 could not see

**There is no liftable function.** The file's only top-level functions are `num` (`:154`),
`compareRows` (`:159`) and `clamp` (`:625`). Every chunkId-shaped operation is a **closure inside
`executeImpl`** (`:236`): `collectSide` (`:344-406`), `inStream` (`:299-302`), `streamWhere`
(`:285-296`).

So "build the batched form first" requires an **extraction refactor before any batching**, which is
why this is M and not S. The instruction is still right — it just is not free.

## Approach

1. **Extract** the per-chunk logic out of `executeImpl` into module-level functions taking an explicit
   `(store, row, opts)` rather than closing over `executeImpl` locals. No behaviour change; the
   existing suite is the guard.
2. **Group by document.** Scan hits cluster heavily in a few documents. One grouped query per
   document plus one boundary probe per document replaces N × 6.
3. **Make the single-target form a thin caller of the batched one** — not the reverse. v12 is explicit
   and the ordering matters: the inverse bakes in the loop.
4. **Then** add `context` to `scan_for_pattern` as a thin caller of the batched form.

## Work

| # | Item | Status |
|---|---|---|
| 1 | Extract `collectSide`, `inStream`, `streamWhere` to module scope with explicit parameters. Existing tests must pass untouched. | ☐ |
| 2 | Add `chunkIds: string[]` to the input schema (`:197-220`) alongside `chunkId`. Keep `rejectsUnknownParams` (`:222`) and the `SAFE_ID` guard (`:64`, `:226`) applied to **every** id. | ☐ |
| 3 | Group requested ids by `documentId` after one batched target fetch, then issue one window query per document. | ☐ |
| 4 | Cap the batch. `MAX_CONTEXT = 3` (`:58`) bounds the window per id; bound the id count too, and say so in the schema. | ☐ |
| 5 | Reimplement the single-id path as a call into the batched one. | ☐ |
| 6 | Only then, add `context` to `scan_for_pattern`. | ☐ |
| 7 | **De-duplication.** [Task 21](./21-chunk-overlap-defect.md) notes that once chunk overlap is restored, a caller concatenating a window gets the shared span twice at every boundary. Batching makes window-concatenation the common path, so decide this here rather than inheriting it. | ☐ |

## Risks

- **Measure before believing the win.** The premise is that hits cluster by document. If a scan's hits
  are spread one-per-document, grouping saves nothing. Measure the clustering on a real scan first.
- **The ordering-ambiguity handling is subtle.** `twinRows` (`:427-430`) exists because partial
  reindex produced duplicate `chunk_index` values within a document (task 21 item 5). Batching must
  preserve the per-stream adjacency logic that task 19 shipped, not reintroduce index ± 1.
- **Do not let a batch fail wholesale.** One bad id must not lose the other nineteen results.

## Acceptance

| Check | Expected |
|---|---|
| `chunkIds` with 20 ids clustered in 3 documents | store operations well below the current 80–120 |
| Same ids one at a time vs batched | byte-identical windows |
| A batch containing one invalid id | the rest still return; the bad one is reported |
| Existing `get-chunk-context.test.ts` | passes unchanged after the item 1 extraction |
| Hit clustering on a real scan | measured and recorded before item 3 is called done |

## References

- `src/lib/mcp/tools/get-chunk-context.ts:58, 64, 154, 159, 167, 171, 197-220, 222, 226, 236,
  266-269, 285-302, 309-316, 344-406, 427-430, 625`
- `src/lib/mcp/tools/__tests__/get-chunk-context.test.ts`
- [`19-chunk-context-tool.md`](./19-chunk-context-tool.md) — the shipped single-target tool
- [`21-chunk-overlap-defect.md`](./21-chunk-overlap-defect.md) — duplicate indices and de-duplication
