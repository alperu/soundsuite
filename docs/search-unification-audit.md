# Search Unification Audit (Task #51)

Mapping every search pathway in the repo. All claims grounded with file:line refs.

## 1. Two parallel grammars

### 1a. Boolean parser (in-house)
`src/lib/search/boolean-query.ts` — hand-rolled tokenizer + precedence-climbing parser.

- Operators (Axon-style): `==`, `!=`, `>=`, `<=`, `>`, `<` and legacy `:` alias for `==` — see `FIELD_OP_RE` at `boolean-query.ts:23` and `CompareOp` at line 5.
- Booleans: `AND`/`OR`/`NOT` — both upper and lowercase accepted (`OP_WORDS`, line 25). Implicit AND between adjacent terms (`parseAnd`, line 207).
- Unary negation: `-foo` at word boundary (line 51).
- Parens: `(` / `)` (line 47).
- Phrases: `"..."` with `\"` and `\\` escapes (line 64).
- Field-qualified terms: `field<op>value` inline, or `field<op>"phrase"` (line 110-156). Space after operator = parse error (line 153).
- No `@id` ref literal type — `caseRef==@uuid` tokenizes as field `caseRef`, value `@uuid` (an opaque string).
- No `contains`/`matches`/`near`. No range syntax (`a..b`).

### 1b. Haystack/Axon parser (third-party)
`src/lib/legal/haystack-filter-sql.ts:33-37` — calls `HFilter.parse()` from the `haystack-core` npm package. Real Project-Haystack v4 grammar.

- Operators include `==`, `!=`, `>=`, `<=`, `>`, `<` plus `has`/`missing` (line 262), and the boolean keywords `and`/`or`/`not` are **lowercase only** in Axon (uppercase will fail in `haystack-core`).
- `@<id>` refs are first-class (resolves to a Ref node).
- Path traversal (`judgeRef->displayName`).

## 2. Haystack chip UI

Real name is **`HaystackFilterInput`** (`src/components/search/haystack-filter-input.tsx`) — *not* `HaystackChipInput`. 477 lines.

- State (line 144-227): cursor position, chips array (`FilterChip[]`), freetext string, active-token detection, picker highlight.
- Chip kinds rendered (line 425-438): pills with `categoryClasses[cat]` — `ref`/`date`/`enum`/`number`/`text` from `ChipCategory` in `haystack-query-builder.ts:18`.
- Keyboard: Enter commits highlighted picker option or submits (line 324, 381); Tab commits (line 366); Backspace at col 0 with empty text removes last chip (line 374); ArrowUp/Down navigates picker (line 310 region).
- Chips compile to a filter string via `buildHaystackFilter` (`haystack-query-builder.ts:222`) only when the form submits.

A separate dumber composer `BooleanChipComposer` (`src/components/search/boolean-chip-composer.tsx`, 923 lines) exists for the `booleanMode + chipComposer` checkbox combo. Independent code path.

## 3. Submit pipeline

`src/components/search-interface.tsx` submit handler (line 2030-2036):
- `haystackMode && (chips.length > 0 || /\w+:/.test(aiQuery))` → calls `runHaystackSearch()` (line 442) which posts `{filter, freetext}` to `/api/search/haystack`.
- Otherwise → `handleAISearch` → POSTs to `/api/search/ai` (line 883) with `mode: 'boolean'` when `booleanMode` is on (line 896).

`/api/search/haystack/route.ts:102-208` orchestrates two branches in parallel:
1. **Freetext-only → interpreter cascade** (line 128-145): if `filter` is empty, calls `interpretQuery()` (`src/lib/search/freetext-interpreter.ts:596`). Returns `{compiledFilter, freetextResidual, confidence}`. **Stage A** is deterministic pattern extraction; **Stage B** heuristic; **Stage C** LLM fallback is scaffold only (`freetext-interpreter.ts:906-923`, comment "scaffold").
2. **Filter present → `callHaystackRead`** (line 75-100): fetches `/api/haystack/read?filter=...` and merges results.
3. **Freetext present → semantic** (line 161-176): `query_case_knowledge` MCP tool.

A separate route `/api/search/interpret/route.ts` (105 lines) wraps the same `interpretQuery()` — duplicate entrypoint to the same interpreter (no LLM yet). The CLAUDE.md / task spec called this `/api/search/haystack/interpret`; the actual path is `/api/search/interpret`.

## 4. `@id` ref resolution

- Haystack-read backend: `haystack-filter-sql.ts` walks the HFilter AST and emits SQL `WHERE` clauses against the Kysely/Prisma legal schema. `@<id>` is recognized as a Ref node and matched against FK columns (e.g. `caseRef==@x` → `caseId = 'x'`).
- Boolean parser: `caseRef` is **NOT** in `FIELD_RESOLVERS` (`boolean-to-fts.ts:42-54`) — only `case`, `caseId`, `caseNumber`, `documentId`, `filingId`, `filingType`, `documentType`, `motionType`. So `caseRef==@uuid` falls through as an unknown-field term, degrades to a literal `caseRef==@uuid` text match (line 84-90). No `@` stripping, no FK lookup. **This is the load-bearing gap for #54.**

## 5. Feature overlap

| Feature | Boolean parser | Haystack (`haystack-core`) |
|---|---|---|
| `==` `!=` `>=` `<=` `>` `<` | yes (`boolean-query.ts:23`) | yes |
| `:` legacy alias | yes (line 23) | no — `chipString` reader uses `:` only as a UI encoding (`haystack-query-builder.ts:285`) |
| AND/OR/NOT case | mixed (line 25) | lowercase only |
| Parens | yes | yes |
| `"phrase"` | yes (line 64) | yes (Axon string literal) |
| `-foo` shorthand | yes (line 51) | no |
| `@id` ref | tokenizes as text | first-class Ref |
| `contains`/`matches` | no | no (the user's "Haystack has these" assumption was wrong) |
| `has` / `missing` | no | yes (`haystack-filter-sql.ts:262`) |
| Range `a..b` | no | no (the chip UI synthesizes two terms — `haystack-query-builder.ts:170-173`) |
| Token aliases (`judge`→`judgeRef`, `filedAfter`→`courtFilingDate>=`) | no | no — these are **chip-UI shortcuts**, not grammar (`TOKEN_MAP` line 67-91) |

## 6. Backend pipeline overlap

Boolean path: `/api/search/ai` (line 883) → `query_case_knowledge` MCP tool → `parseBooleanQuery` (`query-case-knowledge.ts:14`) → `extractFieldFilters` lifts AND-ancestor field terms to SQL `WHERE` against LanceDB scalar columns (`boolean-to-fts.ts:68-146`) → `astToLanceQuery` builds FTS `BooleanQuery` → LanceDB hybrid search.

Haystack path: `/api/search/haystack` → `/api/haystack/[op]/route.ts:927` opRead → `tableFromFilter` regex-scans for entity marker (`repo.ts:177-214`) → routes to `findMotion`/`findCase`/etc. (line 1008-1016) → `compileFilter` (`haystack-filter-sql.ts:339`) → Kysely SQL against the **legal** schema (Motion/MotionEvent/Person tables), NOT LanceDB.

**Two completely separate data stores.** LanceDB has documents/chunks; the legal schema has structured legal entities. Field resolvers map differently. There is no shared resolver registry.

## 7. What the user sees today (all 3 checkboxes on)

Submit handler (line 2030): `haystackMode` wins. If any chip is committed OR text contains `\w+:`, `runHaystackSearch()` fires — POSTs to `/api/search/haystack`. `booleanMode` + `chipComposer` checkboxes affect *which input component renders* (line 2063 picks `BooleanChipComposer` only if `!haystackMode`) but the submit path bypasses both. So with `haystackMode=true`, the other two checkboxes are dead-effect on submission and only matter when the user explicitly toggles `haystackMode` off.

Persisted state keys: `search.booleanMode`, `boolean-chip-composer` (note: missing `search.` prefix), `search.haystackMode` (search-interface.tsx:320, 321, 383).
