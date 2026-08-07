# Fantom MCP — SoundSuite Indexing Report (round 7)

**Date:** 2026-05-07
**Project:** SoundSuite, **id 271**

## Big fix: `refreshFantomProject` no longer destroys the rich index

Round 5–6 regression: `refreshFantomProject` blew away the 4541-fn
tree-sitter index and replaced it with the 30-fn regex output. This round:

```
refreshFantomProject({projectId: 271})
→ functionsIndexed: 0, typesIndexed: 0, filesProcessed: 0, duration: 49ms
```

Then health check after refresh:
```
prisma:     { functions: 4541, types: 221 }   // still rich
flexsearch: { symbols: 30 }                   // unchanged
```

So refresh now correctly detects "nothing changed" and **leaves the rich
Prisma data alone**. Huge improvement — the most painful regression from
prior rounds is gone.

## What's still wrong

### 1. FlexSearch is not synced from Prisma

Health output is unambiguous:
```
prisma.functions:      4541
flexsearch.symbols:    30
diff.missingFromSearch: 4732
warnings: [
  "FlexSearch underpopulated for typescript project —
   searchFantomCode will return empty results"
]
```

Net effect: `searchFantomCode("classify")`, `searchFantomCode("ingest")`,
`semanticCodeSearch("PDF document ingestion pipeline")` all return 0
hits, even though `IngestionPipeline`, `FilingTypeClassifier`, etc. exist
both on disk and in Prisma.

The 30 entries currently in FlexSearch are leftover regex-era rows for
`MockRedis.*` — i.e. FlexSearch hasn't been touched since the regex
era. The tree-sitter run that populated Prisma never wrote to FlexSearch.

### 2. LadybugDB graph is empty

```
ladybug: { nodes: 0, edges: 0 }
diff.missingFromGraph: 4762
warnings: [
  "graph empty despite Prisma rows — earlier reindex likely hit
   cross-project hash collisions; run scripts/cleanup-orphan-nodes.mts
   then reindex"
]
```

So `getCallers`, `getCallees`, `getCodeImpact`, and `getCodeNeighbors` all
have nothing to traverse. The health tool literally tells you the
remediation script (`scripts/cleanup-orphan-nodes.mts`) — the cleanup +
reindex loop should probably run automatically as part of the index
pipeline.

### 3. LanceDB vectors are empty

```
lance: { vectors: 0, coverage: 0 }
```

So `semanticCodeSearch` can't return anything for this project regardless
of query (confirmed: returned "No matching code found" for
"PDF document ingestion pipeline").

### 4. `IndexRun` still not persisted

```
indexRun: null
```

`whatChangedRecently`, `listIndexRuns`, `getSymbolHistory`, `diffByTime`
remain empty for this project.

### 5. `listFunctionsInFile` doesn't see Prisma rows

```
listFunctionsInFile({
  filePath: ".../src/lib/ingestion/ingestion-pipeline.ts",
  projectId: 271
})
→ { symbols: [], total: 0 }
```

Prisma has 4541 functions across this project — the file should have
real symbols. Either `listFunctionsInFile` reads from FlexSearch (which
is mostly empty) or from LadybugDB (which is fully empty), instead of
Prisma.

### 6. `projectId` filter on `searchFantomCode` (carryover)

`{query, projectId:271}` returns 0 even when the matching symbol is in
FlexSearch; `{query, projectName:"SoundSuite"}` resolves to the same
projectId and returns hits. Bug from round 6 unchanged.

## Score sheet vs. round 6

| Issue                                              | Round 6 | Round 7 |
|----------------------------------------------------|---------|---------|
| `refreshFantomProject` regresses to regex output   | OPEN    | ✅ FIXED — refresh now no-op when unchanged |
| Prisma carries tree-sitter rich data (4541/221)    | OK      | OK      |
| FlexSearch in sync with Prisma                     | OPEN    | OPEN    |
| LadybugDB has graph nodes                          | OPEN    | OPEN    |
| LanceDB has vectors                                | OPEN    | OPEN    |
| `IndexRun` rows persisted                          | OPEN    | OPEN    |
| `searchFantomCode` projectId filter                | OPEN    | OPEN    |
| `listFunctionsInFile` returns symbols              | OPEN    | OPEN    |
| `getCodeNeighbors` resolves names from search hits | OPEN    | (untested this round) |
| `getIndexHealth` warnings actionable               | NEW     | ✅ even more specific now ("FlexSearch underpopulated…") |

## Highest-leverage next fix

After every successful Prisma write in the index pipeline, mirror the
rows into FlexSearch (and LadybugDB and LanceDB). Right now the
tree-sitter pipeline writes Prisma cleanly, then exits; the other three
stores are left in their previous (regex / empty) state. The health
tool is already telling you in plain English what's missing — wire the
mirroring step and four search/graph/vector tools start working at
once.

## Bottom line

The destructive-refresh bug is gone. Prisma is now reliably rich
(4541 fns / 221 types) and survives across calls. The remaining work
is store-mirroring: Prisma → FlexSearch, Prisma → LadybugDB, Prisma →
LanceDB. After that:

- `searchFantomCode` will return real hits
- `semanticCodeSearch` will work
- `getCallers/Callees/CodeImpact/CodeNeighbors` will work
- `listFunctionsInFile` will work

Each of those tools is currently broken not because the tool is wrong
but because its backing store is empty.
