---
name: soundsuite-mcp
description: "Query the Sound Suite / court-lens-mcp case-document engine from a Cowork session — regex phrase search across one or many cases, evidence retrieval, case/motion/person discovery, and deep research jobs. Use when asked to search, cite, or analyse case documents."
---

# Querying Sound Suite

Sound Suite (`court-lens-mcp`) indexes court PDFs and exposes them as MCP tools.
This skill is how to reach it from a cloud session, and how to read what comes back.

**No number in this file is a fact about today's corpus.** Document counts, coverage
percentages, chunk totals, tool counts and model names all move. Each has a call that
returns the live value, and this file names the call instead of the number. A bare constant
here is a bug in this file — re-derive it.

## 0. Preflight — run this before you trust anything

```js
await ss.preflight();
```

Returns fleet declared-vs-reported gaps, live corpus denominators, and — the part that
matters — a **timed retrieval probe**. Read `verdict`:

| verdict | means |
|---|---|
| `healthy` | scan and retrieval both serving |
| `degraded — …` | retrieval works; a sidecar declares a container it does not report |
| `BLOCKED — retrieval path hangs` | `ss.ask` and research will hang. `ss.scan` still works — it uses no model. |

**`notReady` alone is not evidence.** It has been observed empty while the retrieval path
hung *and* empty while it was healthy, so on its own it carries no information. That is why
`preflight` probes with a timeout instead of asking.

Retrieval flaps: serving in seconds, then hanging minutes later, within one session. If a
retrieval call stalls, re-run `preflight` rather than assuming your query is at fault.

## 1. Transport — read first, it is not obvious

Sound Suite listens on the Mac's **loopback**. Only one of the three places you can run
code reaches it:

| Where | Reaches `localhost:3000`? |
|---|---|
| Cloud container (`Bash`) | ❌ different machine |
| `device_bash` | ❌ isolated Linux VM — its localhost is not the Mac's |
| **Browser pane** (`Claude_Browser__javascript_tool`) | ✅ runs on the Mac |

Every call is a **same-origin `fetch()` in the browser pane**. Cross-origin fails with a
bare `TypeError` — that is CORS, not a dead port.

## 2. Connect (two calls)

```
Claude_Browser__preview_start  →  http://localhost:3000/api/health
```

then inject the client, which the repo serves from `public/mcp-client/`:

```js
await fetch('/mcp-client/soundsuite-client.js').then(r => r.text()).then(eval);
// → "soundsuite-client <version> ready at http://localhost:3000"
```

`ss` is now available. If the pane refuses the site, call `Claude_Browser__request_access`
(scope `site`) and retry. If the fetch 404s, the dev server is not running — read
`public/mcp-client/soundsuite-client.js` and inject its text instead.

**Ask the client what it can do — do not rely on a function list written here:**

```js
ss.help();            // every function, its arguments, and why it exists
ss.help('digest');    // one function
```

`help()` compares the functions that exist against the ones it documents and reports
`drift` when they disagree. A non-`none` drift means the client and its own catalogue are
out of sync — fix that before trusting either.

**Long-term:** registering the bridge in the desktop app's *Local MCP servers* panel gives
native `mcp__remote-devices__sound-suite-local__*` tools and makes the injection step
unnecessary — see `docs/MCP-Improvements/TASK-07-*.md`.

## 3. Find a phrase — the everyday call

```js
await ss.digest('[Uu]nbeknownst', { limit: 60 });
// → { raw, unique, provenance: { line, verdict, … },
//     passages: [{ cite, page, type, caseId, chunkId, snip }] }
```

`digest` scans, de-duplicates, centres each snippet **on the match** rather than at the
chunk start, and attaches a provenance footer. Hand-assembling that footer is what once put
a wrong coverage percentage into a filing — do not rebuild it inline.

`ss.scan()` is the raw call when you want the untouched payload. The full response of any
call is always in `ss.last`.

`scan_for_pattern` is a **true regex scan**: character classes, alternation and mid-word
fragments all work. Catastrophic patterns are rejected up front with **`INVALID_REGEX`**
(400) before any scan runs.

Recall is **self-reporting**. Every scan result carries:

```jsonc
{ "results": [...], "strategy": "fts+regex" | "full-scan",
  "candidatePool": 21,        // fts+regex only — candidates the keyword pass found
  "scanned": 25560,           // full-scan only — chunks examined before the page filled
  "truncated": false,         // full-scan only — true if the time box cut the scan short
  "nextCursor": "…",          // present when more may exist; absent when exhausted
  "warnings": [] }
```

Scan rows carry `chunkId`, `match`, `blockType` and `headingPath` alongside the citation
fields. `chunkId` is what you feed to `ss.widen()`. `limit` is client-supplied, not a server
cap; results paginate via `nextCursor`.

### Reading the verdict

`provenance.verdict` is the honest summary of what the scan established:

| verdict | means |
|---|---|
| `matches-found` | rows returned, recall not capped |
| `matches-found-capped-pool` | rows returned, but the count may understate |
| `proven-absent` | exhaustive scan, server issued its absence clause |
| `inconclusive-truncated` | the time box cut the scan short |
| `inconclusive-more-pages` | rows remain unscanned — paginate with `ss.exhaust()` |
| `zero-unqualified` | zero rows and no claim — check `strategy` before believing it |

**Never report a bare "N hits".** Quote `provenance.line` alongside it.

### Four parameters that changed the defaults

```jsonc
{ pattern: "…",
  mode: "phrase" | "keyword",   // default "phrase" — rows are VERIFIED against the pattern
  linePermissive: true,          // default true  — a phrase may match across a printed line number
  fold: true,                    // default true  — quotes, dashes and diacritics folded before comparing
  limit, caseId, caseIds, cursor, whereClauses }
```

**Rows are verified by default.** A plain multi-word phrase used to return unverified BM25
rows — rows that did not contain the phrase, with empty `warnings`. It now post-filters on
every path. Set `mode: "keyword"` for the old behaviour; it then says so loudly
(*"these rows are keyword (BM25) matches and were NOT verified"*).

**A phrase may match across a transcript line number.** Reporter's records store line
numbers inline, so a phrase spanning a line break has a digit inside it. A plain pattern
matches and the `match` field shows what it crossed:

```
match: "agree with how you\n10  structured"
warning: "At least one match on this page spans a printed transcript line number…"
```

Set `linePermissive: false` for a strict, contiguous-text match.

**Glyphs are folded.** A curly apostrophe finds the straight-apostrophe corpus form, and a
name spelled without diacritics finds the spelling with them. **`text` and `match` come back
raw**, never folded, so you cite what the document says. Set `fold: false` to hunt an exact
glyph.

### The coverage rule — why the regex form is often the *more* complete one

The tool checks whether every literal in your pattern is a keyword the index can actually
reach. A literal is **unreachable** if it is under three characters, a mid-token fragment,
or a stopword the tokenizer strips. If any literal — or, in an alternation, any *branch* —
is unreachable, keyword recall would silently miss those matches, so the tool **escalates to
a full scan by itself** and says which condition fired in `warnings[]`.

| Pattern | strategy | why |
|---|---|---|
| `unbeknownst` | `fts+regex` | one reachable whole token; pool is capped |
| `[Uu]nbeknownst` | `full-scan` | the literal is a fragment |
| `[Cc]ould not do` | `full-scan` | survivor is `not`, a stopword; the rest are sub-3-char |
| `[Tt]he was not` | `full-scan` | every literal is a stopword |
| `(MR\.|MS\.|THE COURT)` | `full-scan` | branches too short or stopword-only |
| `(unbeknownst|safeguarding)` | `fts+regex` | every branch has a real token — fast path kept |

A plain literal takes the keyword path, which **caps its candidate pool**, while the same
word in a character class scans every indexed chunk in scope. Do not assume "simplest
pattern = most hits".

### Proving a phrase is absent

The result litigation actually needs. **Two shapes count as proof**, and the warning tells
you which:

1. **Exhaustive scan.** `strategy: "full-scan"`, `truncated` falsy, no `nextCursor`.
   **Never check `scanned` against a number memorised from a doc** — the corpus grows and a
   frozen constant silently stops matching. The scan reports its own denominator.
2. **Uncapped pass over a fully-covered keyword set.** `strategy: "fts+regex"`, no cap
   warning, and a warning saying the answer is *exhaustive over the index* followed by the
   denominator it was proven from.

Both prove absence **from the INDEX, not the corpus**, and the clause says so in its own
words. It carries both denominators — what was read in scope, and what that is of the whole
corpus:

```
The scan read all <N> chunks in scope to the end of the table and matched nothing:
proven absent from the <N> indexed chunks of this case, spanning <a> of <b> documents
(<p>% indexed); <c> of <d> corpus-wide, <q>%.
```

Scoped to several cases it reads *"of these cases"* and sums them; unscoped it omits the
second half, because it already **is** the corpus. **Quote that clause verbatim.**
`ss.provenance()` does this for you and computes coverage itself only when the server had no
reason to state it — one source of truth, never two.

The `scanned` count is quoted **alongside** the denominator, not instead of it. If the two
disagree, the scan and the vector store disagree about the corpus, and you want to see that.

**A full-scan zero stays silent in three cases, deliberately** — no claim is better than a
wrong one:

| Situation | Why no claim |
|---|---|
| `truncated: true` | the time box cut the scan short |
| `nextCursor` present | rows remain unscanned |
| you passed a `cursor` | this is one page of a longer answer; earlier pages may have matched |

So the presence of the claim is itself the signal. A `full-scan` zero **without** it means
check `truncated` and `nextCursor` before treating the answer as complete. **Never read
"proven" together with `truncated: true`.**

**Read the denominator before relying on a negative.** Coverage is partial and varies
sharply per case. An absence is proven *of the corpus* only at complete coverage.
`ss.preflight()` or `corpus_status` gives today's figures; a scoped scan's clause quotes that
scope's own numbers, not the corpus average.

**Note the asymmetry.** Chunk counts and document counts move independently — newly
discovered documents raise the document denominator without adding chunks until they are
indexed. So an exhaustiveness claim over chunks can stay true while a coverage claim over
documents silently degrades. Quoting both is what makes that visible.

### Three things that still defeat a proof

- **A capped pool.** *"Keyword recall was capped at N candidates"* → incomplete. At small
  `limit` the tool escalates rather than ending on a capped page; at larger `limit` the cap
  threshold rises (`fetchLimit = (offset + limit) * 5`), so the *same query* can answer on
  either path. The strategy shifts with `limit`; the verdict does not — read `strategy` each
  time rather than assuming.
- **Natural-language input is exempt from the coverage rule**, which is gated on the pattern
  looking like a regex. A plain phrase with no metacharacters whose words are all stopwords
  is neither proven nor escalated — only hedged. **Put one metacharacter in it**
  (`[Tt]he was not`) to buy coverage.
- **"Reachable" is judged against a hand-maintained stopword list** mirroring the index's
  own, plus the three-character floor. A stopword missing from that list would read as
  reachable and a zero would be called *proven* when recall never ran. Trustworthy for
  ordinary English; where a negative finding turns on it, run the control.

### The control check — run it on any zero that matters

```js
await ss.control('[Cc]ould not do', { caseId });
// → { a, b, agree, verdict }
```

Runs the pattern and a de-tokenised variant and compares the document sets. Disagreement
means the result was about **recall**, not the corpus. This has caught every recall defect
found so far. Report `verdict` with any negative finding you rely on.

### Exhausting a paginated answer

```js
await ss.exhaust('[Ss]afeguard', { caseIds: [a, b], maxPages: 20 });
// → { pages, unique, exhausted, escalated, rows }
```

De-duplicates by `chunkId` and flags mid-run escalation. **If a page escalates mid-answer**
while you hold a cursor, escalation restarts at offset zero and earlier rows may repeat — so
de-duplicate before counting. The `full-scan` path honours `caseIds` too.

### Scoping to one case, or a subset

| Parameter | Accepts | Tools |
|---|---|---|
| `caseId` | a **string** (one case) | `scan_for_pattern`, `query_case_knowledge`, `research_evidence` |
| `caseIds` | a **string array** (a subset) | the same three, plus `query_case_graph` (where `caseScope` is an alias) |

Unscoped is the default and spans **every** case — cross-case search needs no parameter.
`caseId` and `caseIds` are mutually exclusive; both together is a 400. A one-element
`caseIds` normalises to `caseId`, so citations are byte-identical either way. Under a
multi-case scope every row is formatted for **its own** case.

Bad input fails loudly instead of lying:

```
caseId: ["A","B"]        → 400  caseId must be a string, received array
caseScope: [...] on scan → 400  unknown parameter: "caseScope" — use "caseIds" on this tool
caseId: "<typo>"         → 400  case not found: "<id>" — call list_cases for valid caseId values
patern: "…"              → 400  unknown parameter: "patern". Accepted parameters: …
```

**Pass full UUIDs** — a truncated id is a `case not found` 400, not an empty result.

Unknown-key rejection is on for `scan_for_pattern`, `query_case_knowledge`,
`query_case_graph` and `research_evidence` — **not** for the LLM analysis tools or the
discovery tools, where a typo'd key is still silently ignored.

**⚠️ Scoping does NOT lift the recall cap.** Scope narrows *which* cases, not *how many
candidates the keyword pass considers*. **Filtering an unscoped scan client-side is not
equivalent** — the cap bites before your filter runs, so matches from the cases you care
about are silently lost. Scope at the source.

## 3a. Who said it — transcript speaker attribution

The `speakers` column is null, but transcripts **print** their labels, so attribution is in
the text. Two label forms, both searchable:

- **Colloquy** — `MR. SURNAME:`, `MS. SURNAME:`, `THE COURT:`, `THE WITNESS:`
- **Q&A** — numbered lines `N  Q ` (examining counsel) and `N  A ` (the witness on the stand)

**(a) Find a named speaker's turns.**

```js
await ss.speakers('MR. SURNAME', { caseId });
// → { rows, turns, basis, caveat, items }
```

`basis` and `caveat` are part of the answer, not decoration.

**(b) Attribute a phrase you already found.** Slice backwards from the match; take the
**last** label or Q/A marker before it:

```js
const before = t.slice(Math.max(0, i-900), i);
const labs = [...before.matchAll(/(MR\.|MS\.|MRS\.|THE COURT|THE WITNESS)\s*[A-Z'-]*\s*:/g)];
const speaker = labs.length ? labs[labs.length-1][0] : null;
const qa = [...before.matchAll(/\n?\s*\d{1,2}\s+([QA])\s/g)];
const qaMark = qa.length ? qa[qa.length-1][1] : null;   // 'A' = the witness, 'Q' = counsel
```

**(c) Turn an `A` into a name — the witness index.** A `Q`/`A` block tells you *witness vs
counsel*, not *which witness*. Every reporter's record opens with an index listing each
witness against the page its examination starts on. Scan the volume for `CROSS-EXAMINATION`
or `duly sworn`: the index hits give a page-range map, and `NAME, having been first duly
sworn` marks each swearing-in.

```
RESPONDENT WITNESSES        DIRECT  CROSS  VOL.
<WITNESS A>   By Ms. X ....... 42      3
              By Ms. Y ....... 90      3
<WITNESS B>   By Ms. X ...... 117      3
```

→ an `A` line on p. 110 belongs to Witness A. Confirm against the nearest `duly sworn` line,
or a counsel line addressing the witness by name.

**Limits to state when you report.** A chunk that opens mid-turn loses its *first* partial
turn (every later label in it is intact) — recover it with `ss.widen()` on that chunk's
`chunkId`. These are labels printed in the text, not `speakers`-column facts. **Give the
basis** — "witness index puts <Name> on the stand pp. 42–116; this is an `A` line on p. 110"
— never a bare "X said Y".

## 3b. Widen a hit

Chunks are small and the great majority of consecutive pairs share no overlap, so a
quotation routinely runs off the edge of the chunk you found.

```js
await ss.widen(chunkId, { before: 2, after: 2 });
// → { safeToMerge, contiguous, atDocumentStart, atDocumentEnd,
//     orderingAmbiguous, containsDraft, notes, got, chunks }
```

| Field | Meaning |
|---|---|
| `atDocumentStart` / `atDocumentEnd` | the target really is the first/last chunk — from its own probe |
| `got.before` / `got.after` | how many you actually received |
| `contiguous` | the returned indices run without a gap |
| `orderingAmbiguous` | two rows share a `chunkIndex`; order was tiebroken, not resolved |
| `containsDraft` | some chunk in the window is draft |
| `safeToMerge` | contiguous, not draft, not order-ambiguous — **the only case where you may merge the window into one quotation** |
| `notes[]` | clamping, bounded search, and edge explanations in words |

**Getting fewer chunks than you asked for does not mean you hit the document edge.** Index
gaps exist, so the tool probes for the edge separately — a window can return 1 of 2
preceding chunks with `atDocumentStart: false` and a note saying the neighbour search was
bounded. **Trust the flags, not the array length.**

`before`/`after` clamp to 3 each and the clamp is stated in `notes`. Neighbours never cross
a document boundary, and each carries its own draft marker rather than inheriting the
target's.

**Two limits.** Rows sharing the target's exact `chunkIndex` are never returned — the tool
reports the collision instead of choosing — and stale-generation detection is local to the
target's own index, so a damaged document with a unique-index target is not flagged. Both
matter only on partially-reindexed documents.

`scan_for_pattern` has **no** `context` parameter. Call this per hit: N hits means N calls.

## 4. Discovery — ids without prior knowledge

```js
await ss.exec('list_cases',  { query: '<optional>' })   // → cases[]: caseId, name, caseNumber,
                                                        //   jurisdiction, county, state, totalDocuments
await ss.exec('list_motions', { caseId, hasAmendments: true, limit: 25 })
                                                        // → motions[]: motionId, title, caseId,
                                                        //   caseNumber, startPage, filingId, documentId
await ss.exec('list_people',  { role: 'judge', caseId })  // → people[]: personId, displayName,
                                                          //   roles, motionCount
await ss.exec('resolve_reference', { text: 'human phrasing', limit: 5 })
```

`resolve_reference` returns `{ candidates: [{ kind, id, label, matchedOn, confidence }],
ambiguous }`. It **never collapses to one answer**; `ambiguous: true` when the top two are
close. An exact `caseNumber` scores highest and reports `matchedOn: "caseNumber"`. **A vague
phrase can return zero candidates** — it matches fields, not meaning. If it comes back
empty, fall back to `list_cases` and pick, or scan a distinctive phrase.

**Evidence carries ids directly**, so discovery is often unnecessary: `caseId` on every item
and `motionId` where resolvable. Prefer reading them off a result over making a discovery
call.

## 5. The rest of the surface

```js
(await ss.tools('local')).names     // the live catalogue — do not rely on a list written here
await ss.ask('the notice requirement', { limit: 5 })     // semantic passages + citations
ss.cites(5) / ss.item(0)                                 // from ss.last
await ss.exec('tool_name', { …params }, { profile: 'local' })   // anything not wrapped
```

Beyond search and discovery the profile carries analysis tools for contradictions,
timelines, entities, citations, privilege, tone, obligations, argument structure and claim
evolution, plus exhibit retrieval and saved workflows. Get the exact callable names from
`names` above.

| Question shape | Tool |
|---|---|
| **Where was this phrase said** | **`ss.digest` — never a research tier** |
| Passages on a topic | `ss.ask` (`query_case_knowledge`) |
| Which case / motion / person is this | `resolve_reference`, `list_*` (§4) |
| What comes before/after this hit | `ss.widen` (§3b) |
| Is this zero real | `ss.control` (§3) |
| Amendment lineage, motions by person | `query_case_graph` — callable; seed from an evidence `motionId` |
| Multi-part / comparative | `ss.research` (§6) |
| Saved workflows and templates | `search_workflows` |

### Error codes

| Code | Means |
|---|---|
| `INVALID_PARAMS` | Missing, mistyped, unknown, or mutually-exclusive parameter; the message names it |
| `INVALID_REGEX` | Pattern rejected as catastrophic before scanning |
| `TOOL_NOT_IN_PROFILE` | Routed-only tool called on `local` |
| `POLICY_VIOLATION` | Cloud provider requested on `local` |
| `TOOL_NOT_READY` | Local model host down or busy. **Its absence is not health** — see §0 |
| `LLM_PARSE_ERROR` | Model returned unparseable prose. **An honest failure — not "nothing found"** |
| `LLM_SHAPE_ERROR` | Parsed, but every item was malformed. Also a failure, not a negative |
| `EMBEDDING_UNAVAILABLE` | The local embedder did not answer — a retrieval failure, not an empty corpus |
| `EMBEDDING_DIMENSION_MISMATCH` | Index built with a different embedding model than the one configured |
| `EXECUTION_ERROR` | Unexpected server fault; details stay server-side by design |
| `AUTH_REQUIRED` | Request classified as non-loopback |

### Reading LLM-tool results correctly

Item-level validation runs on all the analysis tools. The contract:

- **An empty list is a genuine negative over the text the tool was given.** It means the
  model found nothing in the chunks passed to it — *not* that nothing exists in the case.
  That denominator is the evidence window, which is narrower than the index, which is
  narrower than the corpus. Trust it as "not in what was read"; do not promote it to "not in
  the record" without widening retrieval and checking `corpus_status`.
- **`LLM_SHAPE_ERROR` means every item was malformed.** Not a negative.
- **`stats: { itemsDropped, warnings[] }` appears only when something was lost.** Its
  *absence* is the "nothing dropped" signal — check for the key before trusting a count.
- **`confidence` is `number | null`.** `null` means unscored; such items are **kept and
  flagged**, never silently dropped. Scored items below `confidence_threshold` are filtered.

Warnings carry field names and counts only — never model text.

## 6. Research tiers and jobs

`fast` is the **only synchronous tier**. `deep`, `deep-report` and `deep-rlm` return
`{ promoted: true, jobId }` in about a second and then run for minutes — **the variance is
real, not a trend**; retrieve time swings by an order of magnitude with load.

**Never use a research tier to locate a phrase.** §3 answers that in a second.

```js
const r = await ss.research('…', { mode: 'deep' });   // → r.summary.jobId
await ss.status(jobId)     // phase, elapsedMs, streamed count
await ss.result(jobId)     // full EvidenceResult once status === 'done'
await ss.cancel(jobId)
```

Retrieval knobs are **nested** under `retrieval` — a top-level `maxEvidence` is silently
ignored. `ss.research()` nests them for you.

Poll with a **`Bash` `sleep 45`** between calls — never loop inside the JS; the tool aborts
at 45 s. To start and leave: `ss.fire('k', 'research_evidence', {…})` then `ss.peek('k')`.

`status` streams the **pre-cap** set, `result` returns the capped set. `stats.caps` reports
what you did not get:

```json
{ "maxEvidence": 12, "maxCharsPerChunk": 800, "evidenceTruncated": true,
  "evidenceTotalBeforeCap": 79, "chunksTruncated": 7, "tablesTruncated": 0 }
```

`chunksTruncated` counts items whose **text** was shortened; `tablesTruncated` counts
`tableMarkdown` cut on a row boundary — deliberately separate counters.

**Progress streams as NDJSON** at `/api/mcp/research/{id}/events`, replaying from `seq: 0`,
with `{seq, ts, type, payload:{phase, message, detail}}`. Read it with a bounded loop and an
`AbortController` — an unbounded read hits the 45 s abort. Events arriving with identical
timestamps and then stopping means the job is **stalled**, not quiet: compare
`phaseElapsedMs` against `elapsedMs`, and if they match the job never left its first phase.

If `outline` comes back `null` with `modelsUsed.outline: "none"`, the host has no instruct
model selected — check `GET /api/config?resolve=localModels` and Admin → AI Services, and
structure the evidence yourself until one is selected.

### Evidence fields

`id, documentId, text, score, rerankScore, citation, citationShort, page, document,
filingType, caseNumber, caseId, motionId, filingSlug, hits, source` (+ `recordStatus` where
known).

**Cite with `citationShort` + `page`, never the bare `documentId`.** `citationShort` falls
back to the source filename when no formal citation is indexed. Snippets carry a
`[Case: … | Filing: …]` prefix.

## 7. Sparse metadata — what it does and does not rule out

A null column means *this field was never stamped*. It does **not** mean the underlying fact
is unavailable — speaker attribution is the standing example: the column is null, the fact
is printed in the text (§3a).

`recordStatus` is populated, so `"filed"` is meaningful — but unknown is common and does
**not** mean draft. `headingPath`, `blockType` and `speakers` remain sparse or null; the
structure backfill is pending.

**Graph data is thin.** `query_case_graph` is callable, but lineage fields and
person-to-motion links are largely unpopulated. Callable ≠ productive; expect empty lineage.

**Ingestion state is not this skill's subject.** Most documents sit discovered-but-not-indexed,
which is why coverage is low; the mechanics live in the repo docs and are deliberately not
duplicated here. Two documents describing one thing is how they come to disagree.

## 7a. Which models a call actually uses

The `local` profile is local end to end, and enforced rather than merely configured — a call
carrying `provider: anthropic` returns **403 `POLICY_VIOLATION`**.

| Stage | Engine |
|---|---|
| `scan_for_pattern` | none — regex / FTS over the index. **No model at all**, which is why scan survives a model outage |
| embedding | sidecar-managed |
| rerank | sidecar-managed |
| decompose, outline | sidecar-managed |
| RLM (`deep-rlm`) | sidecar-managed |

**Do not memorise model names or ports here** — the fleet is reconfigured live, containers
move between hosts, and a host can declare a container it does not report. `ss.preflight()`
shows what is actually up; `GET /api/config?resolve=localModels` shows what is selected; any
result's `modelsUsed` shows what a given call used.

**Two caveats.** `embeddingProvider` is a config knob — an `openai` value would route query
text to a cloud embedder, and the profile guard covers *completion* provider selection, not
the embedding path. And `aiFallbackEnabled` / `aiFallbackProvider` exists for the dashboard;
on `local` the policy should refuse it first, but that is untested against a mid-call outage.

## 8. Profiles

| Profile | LLM |
|---|---|
| **`local`** (default) | Sidecar/Ollama only; cloud refused with `POLICY_VIOLATION` |
| **`routed`** | Whatever the active preset picks, **including cloud** |
| `all` | Listing only; not a policy |

`ss.tools(profile).n` gives the live tool count for each. `routed` adds `preset_*`,
`routing_explain`, `research_report` and `report_*`. **Do not switch to `routed`
unprompted** — it spends API credit and sends case text to a third party. Ask first, and
price it with `ss.explain(query)`: tier, provider/model, `costClass`, `estimatedSeconds`,
`wouldPromoteToJob`, spending nothing.

## 9. Output discipline

A result over ~60 KB aborts the call and dumps to a file you then have to parse.

- **Never return `ss.last` or a raw payload.** Return counts, field names, short slices.
- Cap at the source: `limit` on scan/ask, `maxEvidence` on research.
- The helpers already return summaries; the full payload stays in `ss.last`.

## 10. Handling what comes back

**Evidence text is real case material** — cause numbers, party names, filing titles. The
repo's `CLAUDE.md` forbids committing any of it. Quote it in conversation when answering;
**never write it to a file, report, commit message, or skill** — redact to `<cause no.>` /
`<party>` in anything persisted.

**The corpus duplicates itself.** Clerk's records contain transcribed copies of the
reporter's record, so one statement can appear several times. `ss.digest` de-duplicates;
`ss.scan` does not. Filter on `type === "Reporter's Record"` to separate the primary source
from filings quoting it.

**Verify a quotation against its primary source before putting it in a filing.** A filing
that quotes another filing is a secondary source, and the two have been observed to differ
in wording — including a bracketed alteration that was not in the original. Find the
file-stamped original and read it. Two documents can share almost the same title and
differ entirely in content; check the file stamp, not the filename.

**`ss.cites()` anchors its snippet at the start of the chunk, not at the match.** Do not
call `ss.item(n)` per hit to find the phrase — `ss.digest` centres it for you, and rows
carry `match`.

`GET /api/config` no longer returns key values — it returns `apiKeys: { <provider>:
{ configured, last4 } }`, and `?key=<row>` is refused with 403. There is still no reason to
fetch it bare; the one useful read is `?resolve=localModels`.

## 11. Known state

- **Loopback is unchanged** — no session, no key needed. From any other origin, `/api/mcp/*`,
  `/api/config`, `/api/cases`, `/api/docs/info`, `/api/admin/*` and `POST /api/search/deep`
  all return 401 without an admin session or an `MCP_API_KEYS` credential.
- Sidecar routes stay exempt by design: `/api/health` and `/api/admin/gpu-fleet` (GET)
  answer uncredentialed from any origin — master discovery depends on it.
- A forged single `X-Forwarded-For: 127.0.0.1` still passes and **cannot be closed at this
  layer**; loopback binding is the real control.
- `MCP_AUTH_STRICT_LOOPBACK=routed` also makes `POST /api/search/deep` refuse loopback.
- `structuredContent` returns `true` through the proxy.
- `:3001` is dormant dead code, not a second surface.
- **`git` run through `device_bash` cannot remove its own lock files.** A commit leaves a
  0-byte `.git/index.lock`, `.git/HEAD.lock` and `tmp_obj_*` behind, which blocks the next
  git command. This is the cause of "stale lock, no git process running" — move them aside
  rather than assuming a crashed process.
