# Fantom MCP — SoundSuite Indexing Report (round 3)

**Date:** 2026-05-06 (after user's "bunch of changes")
**Project:** SoundSuite, id 270, language `typescript`

## Big news

`searchProjects` reports **functionCount: 4541, typeCount: 221** — up from 30/1
in round 2. Tree-sitter TS parsing is producing real symbol-level coverage on
its own (presumably from an auto-index on reconnect / startup).

That is a big step.

## Two regressions remain

### 1. `searchFantomCode` couldn't find anything in the 4541-symbol index

While the project showed 4541 functions, queries returned 0 hits:
- `searchFantomCode("classify", projectId:270)` → 0
- (and `async` would have been 0 too if I'd tried it before refresh)

Hypothesis: the tree-sitter indexer wrote results into Prisma + LadybugDB but
did not populate the in-memory FlexSearch index that `searchFantomCode`
queries. So the DB has 4541 rows, the search index has 0 of them.

### 2. `refreshFantomProject` regressed the project back to regex coverage

```
refreshFantomProject({projectId: 270})
→ functionsIndexed: 30, typesIndexed: 1, filesProcessed: 264
```

After this call, `getFantomCodeStats` confirms `byProject.SoundSuite: 30`.
So a single refresh wiped 4541 well-parsed symbols and replaced them with
the 30 regex hits from one MockRedis test class. Two ways this can happen:

- The project's stored `parserType` is `regex`, so `refreshFantomProject`
  faithfully re-uses regex even though `addFantomProject` was called with
  `parserType: tree-sitter-wasm` (storage didn't persist the choice), or
- `refreshFantomProject` always uses regex regardless of stored config.

Either way, **the only path that produces good coverage today is the auto-
index on startup** — any user-driven refresh destroys the result.

## Other observations

- `getFantomCodeStats` works.
- The single auto-index run produced 4541 fns / 221 types — that's
  consistent with a real TS codebase (~ 50 src files of meaningful size
  in court-lens-mcp). No more `.next/` chunk pollution.

## Required fixes for next round

1. **Persist `parserType` per project and honour it on every refresh.**
   `addFantomProject({parserType: "tree-sitter-wasm"})` must be the single
   source of truth.
2. **Populate the in-memory FlexSearch index from the tree-sitter parse
   path**, not just the regex path. Right now Prisma and LadybugDB get the
   rows but searchFantomCode can't see them.
3. (Carryover from round 2) Persist `IndexRun` rows so `listIndexRuns` /
   `diffIndexRuns` return data.
4. (Carryover from round 2) Fix `removeFantomProject` cascade so a "true"
   `prismaRowDeleted` actually means the row is gone, and stop touching the
   removed `CodeNode` Prisma table.

## Bottom line

You're 80 % of the way there. The parser works. The persistence and the
search index just need to be wired together so a `refreshFantomProject`
doesn't blow up the good data, and so `searchFantomCode` can actually return
hits from the rich index.
