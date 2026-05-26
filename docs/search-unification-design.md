# Search Unification Design (Task #52)

Builds on the audit (`search-unification-audit.md`). Locked constraints:
- Axon `==` canonical; `:` legacy alias auto-translated by tokenizer.
- All three checkboxes (`Advanced (boolean)`, `Chip composer`, `Use Haystack filters`) removed.
- One search input. One parser (`boolean-query.ts`, extended). One backend orchestrator.
- `boolean-query.ts` already supports `==` `!=` `>=` `<=` `>` `<` (file:23) — design extends it; does not duplicate.

## 1. Final grammar (EBNF)

```
expr      = or
or        = and ("OR" and)*
and       = not (("AND")? not)*       // implicit-AND between terms
not       = ("NOT" | "-") not | atom
atom      = "(" expr ")" | phrase | term | fieldOp
phrase    = '"' chars '"'              // \" \\ escapes
term      = bareWord                   // identifier or value
fieldOp   = ident op value
op        = "==" | "!=" | ">=" | "<=" | ">" | "<" | ":"   // ":" → "==" in normalize pass
value     = bareWord | phrase | ref
ref       = "@" idChars                // first-class Ref token (NEW)
ident     = /[A-Za-z][A-Za-z0-9_]*/
```

Changes vs. today:
- `ref` becomes a first-class atom kind, not opaque text — emit `Node.compareOp = '=='`, `Node.refId = 'uuid'`, `Node.field = 'caseRef'`. Resolver in #54 turns it into a typed scalar lookup.
- `AND/OR/NOT` keep both upper/lowercase (already the case at `boolean-query.ts:25`); they remain uppercase in the canonical serialization (`astSerialize`, line 300).
- `:` is normalized to `==` in `parseBooleanQuery` (drop the `if (op !== ':') tok.compareOp = op;` branch at line 121, 147 — always set `compareOp`).

Not adopting from `haystack-core`: `has`/`missing` (rare in legal queries; can be modeled as `field!=""`), `->` path traversal (deferred to v2), lowercase-only booleans.

## 2. Migration matrix

| User input today | After unification | Notes |
|---|---|---|
| `(motion AND compel) OR appeal` | parses unchanged | already works |
| `motionType:disqualify` | parses → AST has `compareOp='=='` | normalize `:` at tokenize time |
| `motionType=="disqualify"` | parses unchanged | quoted-value path (line 127) |
| `caseRef==@<uuid>` | parses; resolver lifts to `case_id = '<uuid>'` | **needs new `RefNode` + new resolver in #54** |
| `judge:@<uuid>` | parses; `judge`→`judgeRef` alias→`judgeId = '<uuid>'` | alias table needed (see Open Q) |
| `hearingDate>=2026-06-01` | parses; numeric/date-typed comparator | resolver knows column type |
| `filedAfter:2026-06-01` (chip alias) | parses but `filedAfter` is not a real column — alias to `courtFilingDate>=2026-06-01` | alias table needed |
| `motion and judgeRef==@x` (Axon lowercase) | parses (boolean parser already accepts lowercase, line 25) | works |
| `judgeRef->displayName=="Roberts"` | parse error | not in grammar — surface tooltip "use the chip" |
| `kind has`/`hearingDate missing` | parse error | document as not supported |

Legacy Haystack syntax that ISN'T in unified parser: `->` path traversal, `has`/`missing`. Recommendation: deprecate with a tooltip that points the user at the equivalent chip or `field!=""`.

## 3. Chip kinds in the unified composer

One composer, six chip kinds. Visual treatment additive on the existing `categoryClasses` in `haystack-filter-input.tsx`:

| Kind | Segments | Color | Source |
|---|---|---|---|
| `term` | `[value]` | gray pill | bare word |
| `phrase` | `["value"]` | slate pill, monospace | `"..."` |
| `fieldOp` | `[field] [op-picker ▾] [value]` | category-tinted (ref=purple, date=blue, enum=green, number=amber, text=gray); op-picker is the middle segment | `ident==value` |
| `ref` | `[field] [== ▾] [@HumanLabel]` | purple, label resolved from person/case index | `field==@id` |
| `boolean` | `AND` / `OR` / `NOT` | uppercase, bold, no border | tokens |
| `paren` | `(` / `)` | dimmed, depth-tinted | grouping |

The op-picker dropdown on `fieldOp`/`ref` chips lets users change `==` → `!=` / `>=` / etc. without retyping. Negation shorthand `-foo` renders as a `NOT` chip prefixed to a `term` chip.

## 4. Backend pipeline

```
                ┌──────────────────────────────────────┐
single input ──►│ unified parser (boolean-query.ts +)  │
                │  - normalize `:` → `==`              │
                │  - tokenize `@id` as RefNode         │
                └──────────────┬───────────────────────┘
                               │ AST
              ┌────────────────┴───────────────────┐
              ▼                                    ▼
   extractFieldFilters (LanceDB pre-pass)   resolveLegalRefs (NEW for #54)
   - case/document/filing scalar columns     - caseRef/judgeRef/lawyerRef → FK columns
   - emits SQL WHERE                         - emits parameterized predicates
              │                                    │
              └─────────────────┬──────────────────┘
                                ▼
                   one server orchestrator
                   /api/search   (formerly: /ai + /haystack)
                                ▼
           ┌────────────────────┴──────────────────┐
           ▼                                       ▼
  LanceDB hybrid (FTS + vector)            Legal-schema SQL
  (chunks, citations)                      (motion, person, case rows)
           └─────────────────┬─────────────────────┘
                             ▼
                 merged result envelope
```

Removed/absorbed:
- `freetext-interpreter.ts` Stage A/B keep value in chip-suggestion path; the LLM Stage C scaffold (`freetext-interpreter.ts:906-923`) is deleted — no longer the freetext-to-filter step (we parse directly now).
- `/api/search/interpret` collapses into chip-suggestion calls on focus, not on submit.
- `/api/search/haystack` route handler folds into `/api/search` orchestrator. `/api/haystack/[op]` stays — it's the data-side Haystack API for tag-panel + ref-pickers, separate concern.
- `mode='boolean'` flag on `query_case_knowledge` becomes the only mode; the `legacy` keyword-extraction branch (`query-case-knowledge.ts:186`) is removed.

## 5. Deletion list

- `src/components/search/boolean-chip-composer.tsx` (923 lines) — replaced by unified composer extending `HaystackFilterInput`.
- `boolean-chip-composer` localStorage key (`search-interface.tsx:321`) + `setChipComposer` state.
- `search.booleanMode` localStorage key + `setBooleanMode` state (line 320).
- `search.haystackMode` localStorage key + `setHaystackMode` state (line 383).
- The three `<input type="checkbox">` blocks in `search-interface.tsx:2182-2211`.
- `boolHintVisible`, `boolHintDismissed`, `boolSummary` state and the "Looks like a boolean query — turn on Advanced" amber banner (line 2131-2146).
- `runHaystackSearch` wrapper (line 442-471) — its body becomes the canonical submit.
- `/api/search/haystack/route.ts` — folded.
- `freetext-interpreter.ts` Stage C `tryLlmInterpret` (line 906-923).
- `BooleanChipComposer` import and the conditional ladder at `search-interface.tsx:2063-2076`.
- `mode: 'legacy' | 'boolean'` parameter on `query_case_knowledge` (kept boolean-only).

## 6. Implementation starter list for #53–#55

- **#53 (parser):** Add `RefNode` to `Node` union and a `'REF'` token kind in `boolean-query.ts`; in tokenize, when value starts with `@` emit a Ref leaf carrying `{field, refId}`; collapse `compareOp` `:` to `==` at parse time; add round-trip tests for `caseRef==@x`, `judge:@y`, `motionType=="disqualify"`.
- **#54 (backend):** Extend `FIELD_RESOLVERS` in `boolean-to-fts.ts` with the legal-schema refs (`caseRef`→`case_id`, `judgeRef`→`judge_id`, `lawyerRef`, `movantRef`, `respondentRef`, `clerkRef`, `reporterRef`), then teach `extractFieldFilters` to handle `RefNode` (strip `@`, parameterize); merge `/api/search/haystack/route.ts` into `/api/search/ai` so one orchestrator runs LanceDB + legal-schema in parallel and returns one envelope.
- **#55 (UI):** Replace `HaystackFilterInput` + `BooleanChipComposer` with a single unified composer that emits the six chip kinds from §3; delete the three checkboxes, the `runHaystackSearch` wrapper, and the persisted-mode localStorage keys; route every submit through the single `/api/search` endpoint.

## Open questions for the user

1. **Chip aliases** (`judge`→`judgeRef`, `filedAfter`→`courtFilingDate>=`, `dueBefore`, `motionType` quote-wrap) currently live in `TOKEN_MAP` (`haystack-query-builder.ts:67-91`). Three options: (a) absorb into the parser as alias rewrites so `judge:@x` parses everywhere, (b) keep them as chip-UI sugar only (typing `judgeRef==@x` always works; `judge:@x` only works through the chip picker), (c) drop aliases entirely and require canonical tag names. Recommend (a); confirm.
2. **Lowercase `and`/`or`/`not`** — keep accepted (current behavior) or restrict to uppercase for canonical Axon-ness? Recommend keep accepted.
3. **Path traversal `judgeRef->displayName`** — out of scope for #53–#55 or worth scoping in? Recommend out of scope; v2.
