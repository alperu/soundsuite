# Fantom MCP — SoundSuite Indexing Report (round 4)

**Date:** 2026-05-06 (after another batch of changes)
**Project:** SoundSuite, **id 271** (round 3 used 270; removed and re-added clean)
**Language:** typescript, **parserType passed:** `tree-sitter-wasm`
**Test pattern:** remove → re-add with explicit tree-sitter parser → search

## Summary

| Concern                                | Round 3      | Round 4      |
|----------------------------------------|--------------|--------------|
| `removeFantomProject` cascade error    | ❌ failed    | ✅ clean     |
| `removeFantomProject` truthful return  | ❌ lied      | ✅ accurate  |
| Tree-sitter coverage on add            | ✅ 4541 fns  | ❌ 30 fns    |
| Tree-sitter coverage on refresh        | ❌ regressed | ❌ regressed |
| `searchFantomCode` finds rich results  | ❌ 0 hits    | ❌ 0 hits    |
| `listIndexRuns` returns runs           | ❌ empty     | ❌ empty     |
| `getFantomFunction` qualifiedName      | (untested)   | ❌ broken    |
| `sourceCode` capture                   | (untested)   | ❌ malformed |

The remove-cascade fixes from round 3's report **landed cleanly**. The
parser/persistence story is still broken, plus two new issues surfaced.

## What works now

### `removeFantomProject` — clean

```json
{
  "success": true,
  "projectId": 270,
  "inMemoryCleared": true,
  "graphNodesDeleted": 31,
  "vectorsDeleted": 31,
  "prismaRowDeleted": true,
  "errors": []
}
```

No more `Table CodeNode does not exist` error. `vectorsDeleted` and
`graphNodesDeleted` now report real counts. The next `addFantomProject` no
longer hits a unique-constraint surprise — round 2's bug A is fixed.

## What is still broken

### 1. `addFantomProject({parserType: "tree-sitter-wasm", language: "typescript"})` does NOT use tree-sitter

After a clean remove + add with explicit tree-sitter:

```json
"indexResult": { "functionsIndexed": 30, "typesIndexed": 1,
                 "filesProcessed": 264, "errors": 0, "duration": 155 }
```

Identical to regex output. All 30 hits are `MockRedis.async X()` methods
from `worker-pool-integration.test.ts`. Tree-sitter is being
selected on the wire but the indexer is not using it.

Round 3 saw 4,541 functions / 221 types. That number came from an *earlier
auto-index after reconnect*, never reproducible through the
`addFantomProject` API. The good path appears to be **boot-time auto-index
only**, and any user-driven indexing falls back to regex.

### 2. `searchFantomCode` returns 0 for real source tokens

```
searchFantomCode({query:"classify", projectId:271}) → 0
searchFantomCode({query:"ingest",   projectId:271}) → 0
semanticCodeSearch({query:"document ingestion pipeline that processes PDFs",
                    projectId:271}) → "No matching code found."
```

Yet `FilingTypeClassifier`, `IngestionPipeline`, etc. exist in source. With
only 30 regex hits in the index, this is consistent with the parser issue.

### 3. NEW: `qualifiedName` is missing the pod prefix

`searchFantomCode("ping")` returns:
```json
"qualifiedName": "::MockRedis.ping",   // pod prefix is empty
"podName": "SoundSuite"                // but podName is set
```

So `getFantomFunction({qualifiedName: "SoundSuite::MockRedis.ping"})`
returns "Function not found", while `"::MockRedis.ping"` works. Either:
- the parser should emit `SoundSuite::MockRedis.ping`, or
- `getFantomFunction` should accept the bare form and resolve via `podName`.

Right now the schema-documented format `<pod>::<class>.<method>` is a lie
for non-Fantom projects.

### 4. NEW: `sourceCode` capture is malformed

`getFantomFunction({qualifiedName: "::MockRedis.ping"}).function.sourceCode`:
```
\n  async ping() {{ return 'PONG'; }
```

- Extra opening brace `{{`
- Missing closing `}` (only one closing brace)
- The actual source is `async ping() { return 'PONG'; }`

Looks like the regex body capture is double-counting the opening brace and
truncating one trailing brace. Anyone consuming `sourceCode` for analysis
or display will get broken JS.

### 5. `listIndexRuns` still returns `count: 0`

Round 2/3 carry-over. Multiple successful indexings have run; none are
persisted into `IndexRun`. Without this `diffIndexRuns` and
`getApiChangeHistory` are dead.

### 6. `returnType: "async"` is wrong

```json
"returnType": "async",
"signature": "async ping()",
"tags": [..., "returns:async"]
```

`async` is a keyword, not a return type. `MockRedis.ping` returns
`Promise<string>`. The TS-aware parser would catch this; the regex parser
guesses the first token after the function name as the return type, which
is wrong.

## Recommendations (ordered by leverage)

1. **Make `addFantomProject({parserType: "tree-sitter-wasm"})` actually use
   tree-sitter on the index path that runs at add time.** This is the single
   highest-impact fix — it would take SoundSuite from 30 fns to ~4500 fns and
   eliminate items 2, 4, and 6 simultaneously.
2. **Persist the chosen `parserType` per project** so `refreshFantomProject`
   and any auto-reindex use it consistently.
3. **Emit `qualifiedName` with the pod prefix** (or fix `getFantomFunction`
   to accept the bare form). Pick one shape and document it.
4. **Persist `IndexRun`** on every refresh (regardless of parser).
5. **Once tree-sitter is the active parser, `sourceCode` and `returnType`
   should both be correct as a side effect.** No separate fix needed.

## Bottom line

Two real bugs from round 3 are gone (removeFantomProject cascade, prismaRow
truthfulness). The headline regression — that user-driven indexing falls
back to regex no matter what `parserType` is requested — is unchanged, and
two new TS-correctness issues (`qualifiedName` prefix, `sourceCode`
truncation) are visible now that I'm calling `getFantomFunction`. Wiring
tree-sitter into `addFantomProject` and `refreshFantomProject` is the one
change that would unlock the rest.
