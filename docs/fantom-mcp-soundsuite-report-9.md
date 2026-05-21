# Fantom MCP — SoundSuite Indexing Report (round 9)

**Date:** 2026-05-07 (immediately after the round-8 reconnect)

## Two regressions vs. round 8

### 1. `getIndexHealth` is broken — LadybugDB lock contention on the canonical path

```
getIndexHealth({projectId: 271})
→ "IO exception: Could not set lock on file :
   /Users/alper/Code/mcpfantom/.cache/fantom-graph.db"
```

This is now the **canonical** path (not the stray
`/Users/alper/Code/court-lens-mcp/.cache/fantom-graph.db` from
round 8). So even the in-process server can't get the lock anymore —
something is holding it. Likely candidates:

- The round-8 harness run left a lock file behind after timeout/exit.
- A background `admin-reindex` job is still running and holding the
  graph DB.
- Two instances of fantom-mcp are alive simultaneously (e.g. both the
  HTTP `:3848` server and the stdio server).

The user-visible effect is that **getIndexHealth (the diagnostic tool I
rely on) is now unusable** for SoundSuite this round.

### 2. Global FlexSearch index is empty

```
getFantomCodeStats
→ totalFunctions:    106202   (in Prisma)
   searchIndexSize:  0        (FlexSearch)
   byProject.SoundSuite: 44   (count column on FantomProject row)
```

`searchFantomCode("ping")` with NO filter returns 0 hits — previously
this returned haxall + SoundSuite results easily. So FlexSearch is
empty for every project, not just SoundSuite. This makes every
keyword/semantic search tool a no-op until rebuilt.

## What's still working

| Probe                                | Result        |
|--------------------------------------|---------------|
| `searchProjects("SoundSuite")`       | ✅ id=271, fns=44, types=4 |
| `getFantomCodeStats`                 | ✅ Prisma counts intact (106k total) |
| Prisma persistence of SoundSuite row | ✅ stable across reconnects |

## What's broken right now

| Tool                                 | State |
|--------------------------------------|-------|
| `getIndexHealth({projectId:271})`    | ❌ LadybugDB lock error |
| `searchFantomCode(*, projectName)`   | ❌ 0 hits (FlexSearch empty) |
| `searchFantomCode(*, projectId)`     | ❌ same |
| `searchFantomCode(*)` unfiltered     | ❌ 0 hits globally |
| `semanticCodeSearch(*)`              | ❌ 0 hits (LanceDB empty in round 8) |
| `listFunctionsInFile(*)`             | ❌ 0 (likely same root cause) |

## What probably went wrong between round 8 and round 9

The round-8 harness spawned a second fantom-mcp process with cwd inside
court-lens-mcp. That process:
- Created stray `.cache/` files in court-lens-mcp.
- Failed its first lock attempt (logged in round-8 raw output).
- Likely still touched the canonical mcpfantom `.cache/` for some stores
  before failing.

After that, the live MCP server reconnected, but the LadybugDB lock at
the canonical path is still being held by something. Until it's
cleared, `getIndexHealth` and any graph-traversal tool will error.

## Recommended actions before round 10

1. **Clear stale lock files** in `/Users/alper/Code/mcpfantom/.cache/`
   before reconnecting. (Specifically anything matching `*.lock`,
   `LOCK`, or LadybugDB's lockfile convention.)
2. **Remove the stray `/Users/alper/Code/court-lens-mcp/.cache/`** so a
   future fantom-mcp spawn from this cwd doesn't read or write it.
3. **Server should auto-reload FlexSearch from Prisma at boot** if its
   in-memory size is < some fraction of Prisma's count. Right now boot
   sometimes leaves FlexSearch empty (round 9) and sometimes populated
   (round 6's 105k entries), depending on what code path runs.

## Score sheet vs. round 8

| Issue                                          | Round 8                | Round 9 |
|------------------------------------------------|------------------------|---------|
| `IndexRun` rows persisted                      | ✅ count=5             | ❓ untested (health blocked) |
| `whatChangedRecently` reports                  | ✅ totalChanges=2401   | ❓ untested |
| `getIndexHealth` callable                      | ✅                     | ❌ LadybugDB lock |
| `searchFantomCode` returns hits                | ❌ 0 (empty)           | ❌ 0 (empty, globally) |
| Prisma `function_count` for SoundSuite         | 43                     | 44 (rebuilt slightly) |
| Cache paths resolved relative to install root  | ❌ NEW BUG documented  | ❌ same, lock-spilling consequence |

## Bottom line

We made real progress on persistence in round 8 (IndexRun + ApiChange
landing). Round 9 shows two operational fragilities the next rebuild
needs to address before adding more features:

- LadybugDB lock isn't released cleanly across process boundaries.
- FlexSearch isn't rehydrated at boot from the persisted Prisma rows.

Both are infra-shaped, not feature-shaped — they affect every search
tool today and any new tool that touches the graph store.
