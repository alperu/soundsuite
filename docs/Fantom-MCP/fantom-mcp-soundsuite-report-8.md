# Fantom MCP — SoundSuite Indexing Report (round 8)

**Date:** 2026-05-07
**Project:** SoundSuite, **id 271**
**Method:** both interactive MCP calls AND a new repeatable script:
`scripts/test-fantom-mcp-soundsuite.mjs` (drives the stdio server via raw
JSON-RPC; no extra deps).

## Big news: time-travel persistence is alive

Run the new harness against a freshly reconnected fantom-mcp:

```
✅ whatChangedRecently        totalChanges=2401
✅ listIndexRuns              count=5
✅ getIndexHealth.indexRun    latestId=34 trigger=admin-reindex
```

`IndexRun` and `ApiChange` rows are now being written. That unlocks the
`whatChangedRecently` / `getSymbolHistory` / `diffByTime` /
`compareSnapshots` family. **This was open across rounds 2 through 7** —
real win.

## Persistent gaps

### 1. Search still returns 0 hits for SoundSuite

```
❌ searchFantomCode("classify")             hits=0
❌ searchFantomCode("ingest")               hits=0
❌ searchFantomCode("async")                hits=0
❌ semanticCodeSearch                       hits=0
❌ listFunctionsInFile                      total=0
```

Even with `projectName: "SoundSuite"` (the round-6 workaround that used
to work), no hits. `getFantomCodeStats.searchIndexSize` is now **0
globally**, not just for SoundSuite. So the FlexSearch index
*regressed* this round — it used to hold ~106k entries across all 241
projects and now it's empty even though `byProject` still claims
SoundSuite has 43.

`getIndexHealth.flexsearch.symbols` returns 43 for the project (probably
read from a cached count column in Prisma) but the actual in-memory
index is empty. Net effect: every search/semantic/list tool returns 0.

### 2. Prisma counts dropped from 4541 → 43

```
round 7: prisma.functions = 4541, types = 221
round 8: prisma.functions = 43,   types = 3
```

Either tree-sitter parsing got dramatically more conservative (now only
emitting top-level exports?), or a partial reindex left the DB in a
half-state. The 43 is suspiciously close to the historic regex-only 30.

### 3. LadybugDB and LanceDB still empty

```
❌ getIndexHealth.ladybug   nodes=0 edges=0
❌ getIndexHealth.lance     vectors=0 coverage=0
```

Carryover. Health output still warns: "graph empty despite Prisma
rows — earlier reindex likely hit cross-project hash collisions; run
scripts/cleanup-orphan-nodes.mts then reindex". The cleanup script
exists but isn't running automatically.

### 4. NEW: path-resolution bug for LadybugDB / FlexSearch / LanceDB

When the test harness spawns fantom-mcp with cwd inside the SoundSuite
repo, the server creates a **stray cache tree** inside the project:

```
/Users/alper/Code/court-lens-mcp/.cache/
  fantom-graph.db          30.8M
  fantom-graph.db.wal       1.3M
  flexsearch-local-1.json   6.1M
  flexsearch-local-2.json   5.7M
  flexsearch-local-3.json   5.7M
  fantomvector.db/
  models/
```

These are duplicates of the canonical
`/Users/alper/Code/mcpfantom/.cache/*` files. The original `DATABASE_URL`
fix only covered Prisma's SQLite path. LadybugDB, FlexSearch, and
LanceDB still resolve their on-disk locations relative to `process.cwd()`
and silently create empty parallel stores in whatever directory the
process happens to launch from.

Concrete consequence the harness hit:
```
"error": "IO exception: Could not set lock on file :
 /Users/alper/Code/court-lens-mcp/.cache/fantom-graph.db
 See the docs: https://docs.ladybugdb.com/concurrency"
```
The interactive Claude Code session had locked one stray copy; the
harness tried to lock another. Two stale graph DBs, neither serving
real data.

The fix is the same shape as the `DATABASE_URL` patch: every store
should resolve its path relative to fantom-mcp's install root (or take
an absolute env override), not `cwd`.

## Score sheet vs. round 7

| Issue                                             | Round 7 | Round 8 |
|---------------------------------------------------|---------|---------|
| `IndexRun` rows persisted                         | OPEN    | ✅ FIXED (count=5, latestId=34) |
| `whatChangedRecently` reports                     | empty   | ✅ totalChanges=2401 |
| `searchFantomCode` returns hits                   | OPEN    | OPEN, regressed (global searchIndexSize=0) |
| `searchFantomCode.projectId` filter               | OPEN    | (untestable — index empty) |
| Prisma reflects rich tree-sitter parse            | 4541/221 | ❌ regressed to 43/3 |
| FlexSearch synced to Prisma                       | OPEN    | OPEN, globally regressed |
| LadybugDB graph populated                         | OPEN    | OPEN |
| LanceDB vectors populated                         | OPEN    | OPEN |
| Cache paths resolved relative to install root     | (latent) | NEW BUG documented |
| `refreshFantomProject` non-destructive            | ✅       | ✅ |

## What I delivered alongside this report

`scripts/test-fantom-mcp-soundsuite.mjs` — self-contained Node script.
No deps. Spawns the fantom-mcp stdio server, runs the standard 9-probe
sequence, prints a pass/fail summary line per probe. Use:

```sh
node scripts/test-fantom-mcp-soundsuite.mjs           # summary only
node scripts/test-fantom-mcp-soundsuite.mjs --raw     # + raw JSON dump
PROJECT_NAME=SandStar... node scripts/...             # other projects
```

Run it after every fantom-mcp build/restart; if every line is `✅`,
fantom-mcp is good for SoundSuite.

**Caveat:** running the harness while Claude Code's interactive MCP
session is connected causes a LadybugDB lock conflict (the cwd stray-
cache bug above). Either disconnect the interactive session before
running, or fix path resolution so both processes share the canonical
`/Users/alper/Code/mcpfantom/.cache/`.

## Top three fixes now

1. **Resolve all cache paths (LadybugDB, FlexSearch, LanceDB) relative
   to the fantom-mcp install root, not `cwd`.** Same fix shape as the
   `DATABASE_URL` patch. Ends the stray-cache problem and the lock
   conflict the harness hit.
2. **Sync FlexSearch from Prisma at startup** (or after every successful
   index run). The startup auto-index writes Prisma cleanly but leaves
   the in-memory search index empty / stale, and now the global index
   has dropped to 0.
3. **Investigate the Prisma 4541 → 43 regression.** Either tree-sitter
   coverage got more conservative or a partial reindex truncated rows.
   Tied to fix #1: a stray `.cache/` may have been written, then read,
   producing the lower count.
