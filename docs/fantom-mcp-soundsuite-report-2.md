# Fantom MCP — SoundSuite Indexing Report (round 2)

**Date:** 2026-05-06 (post-reconnect, after fantom-mcp rebuild)
**Project:** SoundSuite (court-lens-mcp), id **270**, language `typescript`, parser
`tree-sitter-wasm`
**Scope:** Re-test after reconnection, this time forcing `tree-sitter-wasm`
parser at `addFantomProject` time to see whether TS coverage improves.

## Headline numbers (unchanged from round 1)

| Metric                 | Value          |
|------------------------|----------------|
| filesProcessed         | 264            |
| functionsIndexed       | 30             |
| typesIndexed           | 1              |
| errors                 | 0              |
| duration               | 158 ms         |

Identical output to the regex run despite explicit `parserType:
tree-sitter-wasm`. All 30 functions are still the `async X()` methods of
`MockRedis` in `src/services/__tests__/worker-pool-integration.test.ts`.

`searchFantomCode("function")` → 0 hits.
`searchFantomCode("classify")` → 0 hits (yet `FilingTypeClassifier`,
`classifyFiling`, etc. exist in source).

## Conclusion

The TypeScript code path is not actually being parsed. Either:
1. `tree-sitter-wasm` is selected but no TS grammar is loaded, so it falls
   back to the regex parser silently, or
2. The file walker still uses the regex-parser file filter even when
   `language: typescript`, missing arrow functions / `function` declarations /
   non-async methods, or
3. Some other path resolution issue means only the one file is being parsed
   in any branch.

## Bugs surfaced this round

### A. `removeFantomProject` reports `prismaRowDeleted: true` but row survives
After `removeFantomProject({projectId: 268})` returned `prismaRowDeleted: true`,
the next `addFantomProject` failed with
`Unique constraint failed on the fields: (name)`. So the Prisma delete didn't
actually take effect (or rolled back). A subsequent `searchProjects` showed
the row as **id 269**, not 268 — so it *was* recreated, but with
`language: "vue"` (despite `addFantomProject` not specifying that, and my call
specifying `typescript`). Two issues here:

- The remove return value lies about row deletion when there's an error
  elsewhere in the cascade (`clearProjectGraph failed: Binder exception:
  Table CodeNode does not exist`).
- Some retry path defaulted `language` to `vue` for a TypeScript project. That
  is not the schema default (which is `fantom`).

### B. `clearProjectGraph` errors on missing LadybugDB table
`removeFantomProject` reported:
```
clearProjectGraph failed: Binder exception: Table CodeNode does not exist.
```
`CodeNode` was migrated to LadybugDB; the cleanup code is still trying to
DELETE from a Prisma table that no longer exists. Should be a no-op when the
graph store is LadybugDB.

### C. `listIndexRuns` still empty
Same as round 1 — after several refresh runs, `listIndexRuns({projectId:270})`
returned `count: 0`. Persisting runs would unlock `diffIndexRuns` /
`getApiChangeHistory`.

## What works (unchanged)

- `searchProjects` is the right primary lookup tool for known projects.
- `addFantomProject` / `removeFantomProject` schemas are clear.
- Exclude patterns hold: 264 files (no `.next/` or `node_modules/` pollution).
- `getFantomCodeStats` is fast and useful for global view.

## Recommendation

To make fantom-mcp useful as a TS index, the missing piece is a working
non-regex parser. Concretely:

1. Confirm a TypeScript tree-sitter grammar is bundled (or load it
   on-demand). If `tree-sitter-wasm` is selected but no TS grammar exists,
   error loudly instead of falling through to regex with the same results.
2. Fix `removeFantomProject` cascade so a successful Prisma delete is
   actually committed (or the return value reflects the rollback).
3. Stop touching the obsolete `CodeNode` Prisma table.
4. Persist `IndexRun` rows so `listIndexRuns` returns history.

Once the parser actually walks TS source, expect SoundSuite's symbol count to
climb from 30 to several thousand and queries like `classify`, `extract`,
`ingest` to return real source-level matches instead of zero.
