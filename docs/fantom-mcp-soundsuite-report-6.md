# Fantom MCP — SoundSuite Indexing Report (round 6)

**Date:** 2026-05-07 (after reconnect with new tools landed)
**Project:** SoundSuite, **id 271**, language `typescript`,
parser `tree-sitter-wasm`

## What's new this round

Six new MCP tools landed: `getIndexHealth`, `listFunctionsInFile`,
`getCodeNeighbors`, `whatChangedRecently`, `getSymbolHistory`, `diffByTime`.
The "what is below this function / what was below last week" question I
raised earlier now has an API surface.

## Precise health snapshot via the new tool

```
getIndexHealth({projectId: 271})
{
  prisma:     { functions: 30, types: 1 },
  ladybug:    { nodes: 0, edges: 0 },
  lance:      { vectors: 0, coverage: 0 },
  flexsearch: { symbols: 30 },
  diff:       { missingFromGraph: 31, missingFromVectors: 0,
                missingFromSearch: 1 },
  indexRun:   null,
  healthy:    false,
  warnings: [
    "graph empty despite Prisma rows — earlier reindex likely hit
     cross-project hash collisions; run scripts/cleanup-orphan-nodes.mts
     then reindex"
  ]
}
```

This is exactly the diagnostic I needed across the previous 5 rounds.
Top-level read: **3 of 4 backing stores are wrong**. Only Prisma and
FlexSearch carry the 30 regex-parsed symbols; LadybugDB and LanceDB are
empty. `indexRun: null` confirms `IndexRun` rows still aren't being
persisted (carried-over bug from rounds 2–5).

## Critical bug — `projectId` filter on `searchFantomCode` is broken

Same query, two filter shapes:

```
searchFantomCode({query:"async", projectId:271})           → 0 hits
searchFantomCode({query:"async", projectName:"SoundSuite"})→ 3 hits
                                                ↑ resolves to projectId:271
```

The `projectName` path resolves to the same project id (visible in the
returned `filters: { projectId: 271 }`) and finds hits. Passing `projectId`
directly returns nothing. So the projectId filter applied to the
in-memory FlexSearch index has a bug — possibly type coercion (number vs
string) or a stale id-map.

This single bug explains 5 rounds of "search returns 0" reports. With
`projectName` instead, `searchFantomCode` works fine on this project.

## Tree-sitter still not active for SoundSuite

Sample search result against the in-memory index:
```
{
  "qualifiedName": "MockRedis.ping",
  "signature":     "Void ping()",            // <-- Fantom Void return type
  "podName":       "SoundSuite"
}
```

TypeScript has no `Void` return type. The `Void ping()` signature is the
Fantom regex parser's output for a method declared `async ping()` in TS.
So `parserType` is stored as `tree-sitter-wasm` (verified via sqlite3 in
round 5) but the actual indexing path is still using the Fantom regex
parser. This matches health output: only 30 fns / 1 type / 264 files.

## Other new tools — partial reach

### `listFunctionsInFile` returns empty for a file with 30 known symbols

```
listFunctionsInFile({
  filePath: ".../worker-pool-integration.test.ts",
  projectId: 271
})
→ { symbols: [], total: 0 }
```

The 30 indexed MockRedis methods all live in this file (verified via
`searchFantomCode` filePath field). Yet `listFunctionsInFile` returns 0.
Likely the same `projectId` filter bug as `searchFantomCode`, or the
file index isn't populated from the regex path.

### `getCodeNeighbors({qualifiedName: "MockRedis.ping"})` → "Symbol not found"

The `qualifiedName` in search results is literally `"MockRedis.ping"`
(round 5 had `::MockRedis.ping`, round 6 dropped the leading `::`). But
`getCodeNeighbors` rejects this exact name. Symbol-name resolution is
out of sync between `searchFantomCode`'s output and
`getCodeNeighbors`'s input.

### `whatChangedRecently` → empty

```
whatChangedRecently({projectId: 271, hoursAgo: 24})
→ { byFile: [], totalChanges: 0 }
```

Consistent with `indexRun: null` from health output. ApiChange events
aren't being recorded, so any time-travel tool (`whatChangedRecently`,
`getSymbolHistory`, `diffByTime`) returns nothing for this project.

## Score sheet vs. round 5

| Issue                                                     | Round 5  | Round 6 |
|-----------------------------------------------------------|----------|---------|
| `searchFantomCode` returns 0 in general                   | OPEN     | ⚠️ workaround: use `projectName` |
| `projectId` filter on `searchFantomCode`                  | (latent) | NEW BUG identified |
| `refreshFantomProject` regresses to regex                 | OPEN     | OPEN    |
| `runIndex` ignores stored `parserType`                    | OPEN     | OPEN (still 30 fns) |
| `qualifiedName` lacks pod prefix                          | OPEN     | OPEN (now bare `MockRedis.ping`) |
| `sourceCode` capture malformed                            | OPEN     | not re-tested |
| `returnType: "async"`                                     | OPEN     | now `Void` (Fantom signature on TS code) |
| `listIndexRuns` empty                                     | OPEN     | OPEN (`indexRun: null` in health) |
| LadybugDB graph empty                                     | (latent) | NEW: confirmed via getIndexHealth |
| LanceDB vectors empty                                     | (latent) | NEW: confirmed via getIndexHealth |
| `getIndexHealth` exists                                   | —        | ✅ NEW tool, very useful |
| `listFunctionsInFile` works                               | —        | NEW tool, returns empty |
| `getCodeNeighbors` resolves names from search             | —        | NEW tool, name mismatch |
| `whatChangedRecently` reports                             | —        | NEW tool, empty (no IndexRun rows) |

## Highest-leverage fixes now

The new health tool shows the chain of dependencies clearly:

1. **Make `runIndex` actually use stored `parserType=tree-sitter-wasm`.**
   Without this, the 30/1/264 number persists, sourceCode is malformed,
   and signatures are nonsense like `Void ping()`. The health warning
   ("graph empty… cross-project hash collisions") is a downstream symptom
   of running the wrong parser.

2. **Fix the `projectId` filter on `searchFantomCode` (and likely
   `listFunctionsInFile`).** The same query works with `projectName` and
   returns 0 with `projectId`. Same id resolves to. Type coercion or
   stale-map bug.

3. **Persist `IndexRun` and `ApiChange` rows on every successful run.**
   Until this happens, all four time-travel tools (`listIndexRuns`,
   `whatChangedRecently`, `getSymbolHistory`, `diffByTime`) are empty
   regardless of how good the parser gets.

4. **Reconcile symbol-name shapes.** Decide canonical
   `<pod>::<class>.<method>` or bare `<class>.<method>`, write all stores
   in that shape, and accept the canonical shape on every name-input
   tool. Right now `searchFantomCode` returns `MockRedis.ping`,
   `getCodeNeighbors` rejects it, `getFantomFunction` accepts
   `::MockRedis.ping` (round 4) — three different conventions.

## Bottom line

The new tooling (especially `getIndexHealth`) is a big jump — it makes
diagnosis a single API call instead of five rounds of probing. But the
core bugs from rounds 1–5 are still present, and the health tool now
makes them measurable: 30/1 in Prisma+FlexSearch, 0/0 everywhere else,
no IndexRun rows, no ApiChange events. Fix `runIndex` parser routing and
the `projectId` filter on `searchFantomCode`, persist IndexRun, and the
rest cascades.
