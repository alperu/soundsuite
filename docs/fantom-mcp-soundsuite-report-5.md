# Fantom MCP — SoundSuite Indexing Report (round 5)

**Date:** 2026-05-06 (round 5)
**Project:** SoundSuite, **id 271**
**DB inspection:** stored `language=typescript`, `parserType=tree-sitter-wasm`
**parserType is correctly persisted** — confirmed by direct SQLite query
on `fantom_projects` table.

## State on entry to this round

```
searchProjects("SoundSuite")
→ functionCount: 4541, typeCount: 221
```

So the auto-index/startup path is producing real tree-sitter coverage.

## Test 1 — `searchFantomCode` against the rich (4541-fn) index

```
searchFantomCode("classify",            projectId:271) → 0
searchFantomCode("FilingTypeClassifier",projectId:271) → 0
searchFantomCode("async",               projectId:271) → 0
semanticCodeSearch("PDF document ingestion pipeline", projectId:271) → none
```

**The in-memory FlexSearch index is empty for SoundSuite even when DB has
4541 rows.** The startup tree-sitter run writes to Prisma + LadybugDB +
LanceDB but does not populate FlexSearch (which is what `searchFantomCode`
queries). This was already flagged in report 3 — still present.

## Test 2 — `refreshFantomProject` against project 271

```
refreshFantomProject({projectId:271})
→ functionsIndexed: 30, typesIndexed: 1, filesProcessed: 264
```

Crucial part: stored `parserType` is `tree-sitter-wasm` (verified via
sqlite3 against `fantom_projects` table), and both `addFantomProject` and
`refreshFantomProject` route through the **same** `runIndex(db, prisma,
project.id, {trigger})` function (per `src/index.ts` lines 4036 and
4106). Yet:

- Auto-index at startup: **4541 functions**
- `runIndex` triggered by `refreshFantomProject`: **30 functions** (regex
  output)

So `runIndex` is either (a) ignoring the stored `parserType` and
hard-coding regex, or (b) tree-sitter is failing inside `runIndex` and
silently falling back to regex without raising.

## Test 3 — DB has rich data, FlexSearch does not

After the regression to 30 fns, `getFantomFunction({qualifiedName:
"::MockRedis.ping"})` still returned full data — so Prisma reads work
fine. But `searchFantomCode("async")` against the same project returned
0 hits — FlexSearch is the broken layer.

## Persistent issues from prior rounds

| Bug                                                   | Status   |
|-------------------------------------------------------|----------|
| `searchFantomCode` returns 0 for everything           | OPEN     |
| `refreshFantomProject` regresses to regex output      | OPEN     |
| `qualifiedName` lacks pod prefix (`::MockRedis.ping`) | OPEN     |
| `sourceCode` capture malformed (`{{` … missing `}`)   | OPEN     |
| `returnType: "async"` (keyword, not type)             | OPEN     |
| `listIndexRuns` returns count: 0                      | OPEN     |

## Fixed (still good)

- `removeFantomProject` cascade no longer errors on missing `CodeNode`.
- `prismaRowDeleted: true` is honest.
- `addFantomProject` auto-picks `tree-sitter-wasm` for non-Fantom languages
  and persists `parserType` correctly to Prisma.

## What's specifically wrong (with evidence)

### Pin 1 — `runIndex` does not honor stored parserType

```sql
sqlite> SELECT id,name,language,parserType,function_count
        FROM fantom_projects WHERE name='SoundSuite';
271|SoundSuite|typescript|tree-sitter-wasm|30
```

After a `refreshFantomProject` call that finishes "successfully" with 30
indexed functions, the DB row still says `parserType=tree-sitter-wasm`.
The number 30 matches the regex parser's MockRedis-only output exactly.
Either:
- `runIndex` reads `project.parserType` and dispatches correctly, but the
  tree-sitter parse path fails internally and is caught + retried with
  regex without surfacing an error, or
- `runIndex` is hard-wired to regex and the comment ("route through the
  unified pipeline so language + parserType are actually honored") at
  index.ts:4007 doesn't match the current implementation.

The startup auto-index proves tree-sitter *can* succeed on this codebase
(it produces 4541/221 reproducibly). So the bug is specific to the
refresh/add code path.

### Pin 2 — FlexSearch population

`searchFantomCode` queries the in-memory FlexSearch index. After a
startup-time tree-sitter run that fills Prisma with 4541 rows,
FlexSearch is empty for that project (every keyword query returns 0).
After the refresh-time regex run that fills Prisma with 30 rows,
FlexSearch is also empty (yes, `searchFantomCode("async")` still returns
0 even with 30 hits in DB). So FlexSearch isn't being populated at *any*
indexing point right now for SoundSuite.

## Recommendation

These two pins block everything else. Concretely:

1. In `runIndex`, log the chosen parser strategy and the file count
   produced before falling back. If tree-sitter is selected, fail loudly
   instead of silently regressing to regex. (This will tell you in
   minutes whether it's "ignored parserType" or "silent fallback".)
2. After every successful index run, sync FlexSearch: load the project's
   functions/types from Prisma into the in-memory index. Right now even
   regex-indexed rows aren't searchable, so FlexSearch is being skipped
   in the user-driven path entirely.

After 1 and 2, every other open bug becomes either fixed-as-side-effect
(returnType, sourceCode, qualifiedName — all consequences of using the
TS parser) or trivially testable.

## Bottom line

`addFantomProject` correctly persists `parserType=tree-sitter-wasm` and
the startup path proves tree-sitter parses this codebase to 4541
functions in seconds. The user-driven code paths
(`refreshFantomProject`, and likely the index-on-add when not coming
through startup) are dropping back to regex despite the persisted
config. And `searchFantomCode` can't see anything regardless. Fix those
two and the rest of round 4's bug list closes itself.
