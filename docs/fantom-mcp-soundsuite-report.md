# Fantom MCP — SoundSuite Indexing Report

**Date:** 2026-05-06
**Project:** SoundSuite (court-lens-mcp), id 268, language `typescript`, parser `regex`
**Scope:** Validate fantom-mcp can usefully index a TypeScript project after the recent
language-generic changes.

## Headline numbers

| Metric                 | Value                                                       |
|------------------------|-------------------------------------------------------------|
| filesProcessed         | 264                                                         |
| functionsIndexed       | 30                                                          |
| typesIndexed           | 1                                                           |
| errors                 | 0                                                           |
| duration               | 121 ms                                                      |
| lastIndexed            | 2026-05-06T20:06:23Z                                        |

Compared with the earlier run (before exclude patterns landed) which produced
**13,881 functions / 18,271 files** dominated by `.next/` chunks and bundled
`node_modules/langsmith` — the new run is clean. Build artefacts are gone.

## What worked

- `searchProjects("SoundSuite")` resolves the project in one call. Much better
  than paging through `listFantomProjects` (which still blew the tool-result
  token cap on the prior run).
- `addFantomProject` / `refreshFantomProject` succeed cleanly with the
  absolute `DATABASE_URL` patch in `~/.claude.json`.
- Excludes now skip `.next`, `node_modules`, build artefacts.
- New tools surfaced: `clearProjectIndex`, `removeFantomProject`,
  `reindexChangedFiles`, `searchProjects`, `listIndexRuns`,
  `diffIndexRuns`, `getApiChangeHistory`. Schemas read well.

## What still misses

### 1. Regex parser barely covers TypeScript
All 30 indexed functions come from a **single file**:
`src/services/__tests__/worker-pool-integration.test.ts`, all methods of
`class MockRedis`. The other 263 files yielded zero functions.

Likely the regex only matches `async <name>()` inside class bodies. It misses:
- `export function foo() { … }` / `function foo() { … }`
- `export const foo = (…) => { … }` arrow functions
- `export const foo = async (…) => { … }`
- Class methods that are not `async`
- Top-level `const x = function() {}`

For a TS codebase, arrow exports and plain `function` declarations are the
overwhelming majority — so the index has roughly 1–2 % coverage of real
symbols.

**Action:** auto-select `tree-sitter-wasm` when `language === "typescript"`
(the addFantomProject schema already lists `tree-sitter-wasm` as an option),
or extend the regex set to include the four patterns above.

### 2. Signature mangling on multi-line bodies
For methods with bodies whose first lines start with keywords, the "signature"
column captures statement fragments instead of parameters, e.g.

```
async scan(Simple scan, returns all, matching keys, in one, go const, …)
async keys(const regex, new RegExp, const allKeys, return allKeys, …)
```

These are the function bodies leaking into the signature field. tree-sitter
parsing would fix this; if regex is kept, the capture group should stop at
the first `)` on the declaration line, not consume comments / following
statements.

### 3. `listIndexRuns` returns empty
After two successful refresh runs in this session, `listIndexRuns({projectId:268})`
returned `count: 0`. Either the runs aren't being persisted, or only specific
trigger types are recorded. Worth verifying.

### 4. `searchFantomCode({query: " "})` returns 0
A space query as a "give me anything" probe returns nothing, while `query:"async"`
returns 30. Document that the query must be a non-trivial token, or treat
empty/whitespace queries as "no filter" and stream results.

## Tool-by-tool spot check

| Tool                       | Result                                  |
|----------------------------|-----------------------------------------|
| `searchProjects`           | OK — found SoundSuite in 1 hit          |
| `refreshFantomProject`     | OK — 264 files / 30 fn / 1 type / 121ms |
| `searchFantomCode`         | OK on real tokens, empty on whitespace  |
| `getFantomCodeStats`       | OK — global stats render well           |
| `listFantomProjects`       | Output blew tool-result cap last run; needs default `limit` lower or compact mode |
| `listIndexRuns`            | Returned `count: 0` despite recent runs |
| `clearProjectIndex` / `removeFantomProject` | Schemas loaded; not exercised |

## Recommendation

For TS projects, the index is currently too sparse to be useful. The two
changes that would unlock value, in priority order:

1. **Default to `tree-sitter-wasm` parser when language is `typescript`,
   `javascript`, `python`, etc.** Regex is fine for Fantom; it isn't for
   anything else.
2. **Persist & expose index runs.** `listIndexRuns` returning empty after
   real runs makes `diffIndexRuns` / `getApiChangeHistory` unusable.

After (1), I'd expect SoundSuite's function count to jump from ~30 to several
thousand of real source-level symbols, and signatures to read correctly.
