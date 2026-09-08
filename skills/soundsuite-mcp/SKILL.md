---
name: soundsuite-mcp
description: "Query the Sound Suite / court-lens-mcp case-document engine from a Cowork session — regex phrase search across one or many cases, evidence retrieval, case/motion/person discovery, and deep research jobs. Use when asked to search, cite, or analyse case documents."
---

# Querying Sound Suite

Sound Suite (`court-lens-mcp`) indexes court PDFs and exposes 25 tools in the `local` profile.
This skill is how to reach it from a cloud session.

## 1. Transport — read first, it is not obvious

Sound Suite listens on the Mac's **loopback**. Only one of the three places you can run code reaches it:

| Where | Reaches `localhost:3000`? |
|---|---|
| Cloud container (`Bash`) | ❌ different machine |
| `device_bash` | ❌ isolated Linux VM — its localhost is not the Mac's |
| **Browser pane** (`Claude_Browser__javascript_tool`) | ✅ runs on the Mac |

Every call is a **same-origin `fetch()` in the browser pane**. Cross-origin fails with a bare
`TypeError` — that is CORS, not a dead port.

## 2. Connect (two calls)

```
Claude_Browser__preview_start  →  http://localhost:3000/api/health
```

then inject the client, which the repo serves from `public/mcp-client/`:

```js
await fetch('/mcp-client/soundsuite-client.js').then(r => r.text()).then(eval);
// → "soundsuite-client 1.0.0 ready at http://localhost:3000"
```

`ss` is now available. If the pane refuses the site, call `Claude_Browser__request_access`
(scope `site`) and retry. If the fetch 404s, the dev server is not running — the source is
`public/mcp-client/soundsuite-client.js`; read it and inject its text instead.

**Long-term:** registering the bridge in the desktop app's *Local MCP servers* panel gives native
`mcp__remote-devices__sound-suite-local__*` tools and makes this skill unnecessary — see
`docs/MCP-Improvements/TASK-07-*.md`. The prerequisite (bridge synced) is done.

## 3. Find a phrase — the common task, in one call

`ss.scan` (`scan_for_pattern`) is a **true regex scan**. Character classes, alternation and mid-word
fragments all work — verified `[Uu]nbeknownst` → 37, `nbeknownst` → 37, `unbeknownst` → 37 on the
same corpus. (If you meet a session or doc saying regex does not work, or that alternation silently
returns zero, it is stale.)

Recall is **self-reporting**. Every scan result carries:

```jsonc
{ "results": [...], "strategy": "fts+regex" | "full-scan",
  "candidatePool": 21,        // fts+regex only — candidates the keyword pass found
  "scanned": 25560,           // full-scan only — chunks examined before the page filled
  "truncated": false,         // full-scan only — true if the time box cut the scan short
  "nextCursor": "…",          // present when more may exist; absent when exhausted
  "warnings": [] }
```

### Four parameters that changed the defaults (2026-09-08)

```jsonc
{ pattern: "…",
  mode: "phrase" | "keyword",   // default "phrase" — rows are VERIFIED against the pattern
  linePermissive: true,          // default true  — a phrase may match across a printed line number
  fold: true,                    // default true  — quotes, dashes and diacritics folded before comparing
  limit, caseId, caseIds, cursor, whereClauses }
```

**Rows are now verified by default.** A plain multi-word phrase used to return unverified BM25 rows —
20 rows, none containing the phrase, `warnings: []`. It now post-filters on every path. Measured: the
same query returns **1 verified row**. Set `mode: "keyword"` to get the old behaviour back, and it
then says so loudly (*"these rows are keyword (BM25) matches and were NOT verified"*).

**A phrase may match across a transcript line number.** Reporter's records store line numbers inline,
so a phrase spanning a line break has a digit inside it. That used to be unfindable. Now a plain
pattern matches and the `match` field shows what it crossed:

```
match: "agree with how you\n10  structured"
warning: "At least one match on this page spans a printed transcript line number…"
```

Set `linePermissive: false` for a strict, contiguous-text match (verified: same query → 0).

**Glyphs are folded.** A curly apostrophe now finds the straight-apostrophe corpus form, and a name
spelled without diacritics finds the spelling with them. **`text` and `match` come back raw**, never
folded, so you cite what the document says. Set `fold: false` to hunt an exact glyph (verified:
curly-apostrophe form → 1 with folding, 0 with `fold: false`).

**Consequence for the digest pattern below and for §3a:** you no longer need to de-tokenise a phrase
by hand to make it work. That trick is still valid as a deliberate control (see *Proving a phrase is
absent*), but it is no longer the price of entry.

### The coverage rule — why the regex form is often the *more* complete one

The tool checks whether every literal in your pattern is a keyword the index can actually reach. A
literal is **unreachable** if it is under three characters, a mid-token fragment, or a stopword the
tokenizer strips. If any literal — or, in an alternation, any *branch* — is unreachable, keyword
recall would silently miss those matches, so the tool **escalates to a full scan by itself** and says
which condition fired in `warnings[]`.

| Pattern | strategy | why |
|---|---|---|
| `unbeknownst` | `fts+regex` | one reachable whole token; pool capped at 21 |
| `[Uu]nbeknownst` | `full-scan` | the literal is a fragment |
| `[Cc]ould not do` | `full-scan` | survivor is `not`, a stopword; the rest are sub-3-char |
| `[Tt]he was not` | `full-scan` | every literal is a stopword |
| `(MR\.|MS\.|THE COURT)` | `full-scan` | branches too short or stopword-only |
| `(unbeknownst|safeguarding)` | `fts+regex` | every branch has a real token — fast path kept |

A plain literal takes the keyword path, which **caps its candidate pool**, while the same word in a
character class scans all ~36k chunks. Do not assume "simplest pattern = most hits". You no longer
need to hand-de-tokenise a phrase to force a scan — the coverage rule does it — but doing so is still
a valid way to force one deliberately, and is the control check below.

### Proving a phrase is absent

The result litigation actually needs. **Two shapes count as proof**, and the warning tells you which:

1. **Exhaustive scan.** `strategy: "full-scan"`, `truncated` falsy, no `nextCursor`, `scanned` equal
   to the corpus (~35,890). Measured: an absent token scanned 35,890 in ~1.8 s.
2. **Uncapped pass over a fully-covered keyword set.** `strategy: "fts+regex"`, no cap warning, and a
   warning saying the answer is *exhaustive over the index* followed by the denominator it was proven
   from. Every branch was reachable and the pool was never truncated, so the keyword pass saw
   everything the regex could match.

**Both shapes prove absence from the INDEX, not the corpus.** Since 2026-09-08 the claim carries its
subject — e.g. *"proven absent from the 380 indexed chunks of this case, spanning 6 of 258 documents
(2.3% indexed)"*. The bare form *"the absence is proven"* is gone; if you see it, you are reading a
stale transcript.

**Both shapes carry the denominator as of 2026-09-08.** An earlier note here said only shape 2 did —
that gap is closed. All three `full-scan` paths (coverage rule, capped-page escalation,
zero-candidate fallback) now add a second warning naming what was read and what that covers:

```
The scan read all 380 chunks in scope to the end of the table and matched nothing:
proven absent from the 380 indexed chunks of this case, spanning 6 of 258 documents (2.3% indexed).
```

The `scanned` count is quoted **alongside** the denominator, not instead of it — if the two disagree,
the scan and the vector store disagree about the corpus, and you want to see that. Measured
2026-09-08 they agree exactly, at both corpus (35,890) and case (380) scope.

**A full-scan zero stays silent in three cases, deliberately** — no claim is better than a wrong one:

| Situation | Why no claim |
|---|---|
| `truncated: true` | the time box cut the scan short |
| `nextCursor` present | rows remain unscanned |
| you passed a `cursor` | this is one page of a longer answer; earlier pages may have matched |

So the presence of the claim is itself the signal. If you get a `full-scan` zero **without** it, check
`truncated` and `nextCursor` before treating the answer as complete.

**Read the denominator before relying on a negative.** Coverage is currently partial and varies
sharply per case — measured 2026-09-08: 96 of 864 documents corpus-wide (11.1%), ranging from 44.4%
down to 2.3% per case. An absence is proven *of the corpus* only at complete coverage. The clause is
scoped to what you searched, so a `caseId` scan quotes that case's numbers, not the corpus average.
Call **`corpus_status`** for the full picture (per-case coverage, chunk counts, last ingest run).

**Never read "proven" together with `truncated: true`.** A full scan is bounded by a time box; cut
short, it sets `truncated` and emits a cursor. Loud rather than silent — but a proven absence is only
proven for a scan that reached the end of the table.

**Three things that still defeat a proof:**

- **A capped pool.** *"Keyword recall was capped at N candidates"* → incomplete. At small `limit` the
  tool escalates rather than ending on a capped page; at larger `limit` the cap threshold rises
  (`fetchLimit = (offset + limit) * 5`), so the *same query* can answer on either path. The strategy
  shifts with `limit`; the verdict does not — but read `strategy` each time rather than assuming.
- **Natural-language input is exempt from the coverage rule**, which is gated on the pattern looking
  like a regex. A plain phrase with no metacharacters whose words are all stopwords is neither proven
  nor escalated — only hedged. **Put one metacharacter in it** (`[Tt]he was not`) to buy coverage.
- **"Reachable" is judged against a hand-maintained stopword list** mirroring the index's own, plus
  the three-character floor. A stopword missing from that list would read as reachable and a zero
  would be called *proven* when recall never ran. Trustworthy for ordinary English; where a negative
  finding actually turns on it, run the control below too.

**The control check, worth doing anyway.** If a scan returns zero, re-run it de-tokenised
(`[Cc]ould not do` → `[Cc]ould [Nn]ot d[o]`). If the two disagree, the zero was never about the
corpus. That trick caught every recall defect found so far.

**Always report `strategy` and `warnings` alongside a count** — an unqualified "N hits" from a capped
pass overstates certainty. **If a page escalates mid-answer** while you hold a cursor, the tool warns
that earlier rows may repeat: escalation restarts at offset zero, so de-duplicate before counting.

### The digest pattern — one call, ~1s

```js
await ss.scan('unbeknownst', { limit: 60 });
const RX = /unbeknownst/i, seen = new Set(), out = [];
for (const r of ss.last?.results || []) {
  const t = String(r.text||''), m = t.match(RX); if (!m) continue;
  const i = t.indexOf(m[0]);
  const snip = (i>220?'…':'') + t.slice(Math.max(0,i-220), i+260).replace(/\s+/g,' ').trim();
  const key = snip.slice(0,120); if (seen.has(key)) continue; seen.add(key);
  out.push({ cite: String(r.citationShort||r.document||'').slice(0,46),
             page: r.page, type: r.filingType, caseId: r.caseId, snip });
}
JSON.stringify({ raw: ss.last.results.length, unique: out.length, strategy: ss.last.strategy,
                 warnings: ss.last.warnings, more: !!ss.last.nextCursor, passages: out }, null, 1);
```

Measured: 37 raw → 27 unique, ~1.1 s. Filter `type === "Reporter's Record"` to separate the primary
source from your own filings quoting it. **Always report `strategy` and `warnings` alongside a
count** — an unqualified "N hits" from a capped pass overstates certainty.

Catastrophic patterns are rejected up front with **`INVALID_REGEX`** (400) before any scan.

Two things that still cost round trips if you do not know them:

- **`ss.cites()` anchors its snippet at the start of the chunk, not at the match.** Do not call
  `ss.item(n)` per hit to find the phrase — centre it yourself (above). Rows also carry `match`.
- **The corpus duplicates itself.** Clerk's records contain transcribed copies of the reporter's
  record, so one statement can appear 4×. Dedupe before you count.

Scan rows carry `chunkId`, `match`, `blockType` and `headingPath` alongside the citation fields.
`chunkId` is what you feed to `get_chunk_context` (§3b).

`limit` is client-supplied, not a server cap. Results paginate via **`nextCursor`** — pass it back to
continue.

### Scoping to one case, or a subset

| Parameter | Accepts | Tools |
|---|---|---|
| `caseId` | a **string** (one case) | `scan_for_pattern`, `query_case_knowledge`, `research_evidence` |
| `caseIds` | a **string array** (a subset) | the same three, plus `query_case_graph` (where `caseScope` is an alias) |

Unscoped is the default and spans **every** case — cross-case search needs no parameter at all.
`caseId` and `caseIds` are mutually exclusive; both together is a 400. A one-element `caseIds`
normalises to `caseId`, so citations are byte-identical either way (verified on both tools). Under a
multi-case scope every row is formatted for **its own** case.

Bad input fails loudly instead of lying:

```
caseId: ["A","B"]        → 400  caseId must be a string, received array
caseScope: [...] on scan → 400  unknown parameter: "caseScope" — use "caseIds" on this tool
caseId: "<typo>"         → 400  case not found: "<id>" — call list_cases for valid caseId values
patern: "…"              → 400  unknown parameter: "patern". Accepted parameters: …
```

Unknown-key rejection is on for `scan_for_pattern`, `query_case_knowledge`, `query_case_graph` and
`research_evidence` — **not** for the ten LLM analysis tools or the discovery tools, where a typo'd
key is still silently ignored.

**⚠️ Scoping does NOT lift the recall cap.** Measured: unscoped and `caseId: A` returned the same
capped pool; `caseIds: [A,B]` at `limit: 60` still reported `candidatePool: 61` with a cap warning.
Scope narrows *which* cases, not *how many candidates the keyword pass considers*.

**Filtering an unscoped scan client-side is not equivalent** — the cap bites before your filter runs,
so matches from the cases you care about are silently lost. Scope at the source.

### Exhaustive multi-case search

```js
await ss.exec('list_cases', {});
const ids = ss.last.cases.map(c => c.caseId);            // or just the subset you want
let cursor = null; const all = [];
do {
  await ss.exec('scan_for_pattern',
    { pattern: '[Ss]afeguard', limit: 50, caseIds: ids, ...(cursor && { cursor }) });
  all.push(...(ss.last.results || []));
  cursor = ss.last.nextCursor;
} while (cursor);
```

The `full-scan` path honours `caseIds` too — verified: a non-tokenisable pattern scoped to two cases
scanned 8,306 chunks and returned rows from exactly those two. Paginating that scope to exhaustion
took 2 pages / 64 results, ending with no cursor.

## 3a. Who said it — transcript speaker attribution

The `speakers` column is null, but transcripts **print** their labels, so attribution is in the text.
Two label forms, both searchable:

- **Colloquy** — `MR. SURNAME:`, `MS. SURNAME:`, `THE COURT:`, `THE WITNESS:`
- **Q&A** — numbered lines `N  Q ` (examining counsel) and `N  A ` (the witness on the stand)

**(a) Find a named speaker's turns.** Scan for the label, then split each chunk on label boundaries
and keep the parts that *begin* with your label:

```js
await ss.exec('scan_for_pattern', { pattern: 'MR\\. SURNAME', limit: 100 });
const turns = [];
for (const r of ss.last?.results || []) {
  const parts = String(r.text||'').split(/(?=(?:MR\.|MS\.|MRS\.|THE COURT|THE WITNESS)\s*[A-Z'-]*\s*:)/);
  for (const q of parts) if (/^MR\. SURNAME:/i.test(q.trim()))
    turns.push({ cite: r.citationShort, page: r.page, text: q.replace(/\s+/g,' ').slice(0,400) });
}
```

**(b) Attribute a phrase you already found.** Slice backwards from the match; take the **last** label
or Q/A marker before it:

```js
const before = t.slice(Math.max(0, i-900), i);
const labs = [...before.matchAll(/(MR\.|MS\.|MRS\.|THE COURT|THE WITNESS)\s*[A-Z'-]*\s*:/g)];
const speaker = labs.length ? labs[labs.length-1][0] : null;
const qa = [...before.matchAll(/\n?\s*\d{1,2}\s+([QA])\s/g)];
const qaMark = qa.length ? qa[qa.length-1][1] : null;   // 'A' = the witness, 'Q' = counsel
```

**(c) Turn an `A` into a name — the witness index.** A `Q`/`A` block tells you *witness vs counsel*,
not *which witness*. Every reporter's record opens with an index listing each witness against the
page its examination starts on. Scan the volume for `CROSS-EXAMINATION` or `duly sworn`: the index
hits (pages 1–6) give a page-range map, and `NAME, having been first duly sworn` marks each
swearing-in.

```
RESPONDENT WITNESSES        DIRECT  CROSS  VOL.
<WITNESS A>   By Ms. X ....... 42      3
              By Ms. Y ....... 90      3
<WITNESS B>   By Ms. X ...... 117      3
```

→ an `A` line on p. 110 belongs to Witness A. Confirm against the nearest `duly sworn` line, or a
counsel line addressing the witness by name.

**Limits to state when you report.** A chunk that opens mid-turn loses its *first* partial turn
(every later label in it is intact) — **recover it with `get_chunk_context` (§3b)** on that chunk's
`chunkId`, which is what the preceding chunk's trailing label is for. These are labels printed in the
text, not `speakers`-column facts. **Give the basis** — "witness index p. 3 puts <Name> on the stand pp. 42–116; this is an `A`
line on p. 110" — never a bare "X said Y".

## 3b. Widen a hit — `get_chunk_context`

Chunks are small (median ~130 chars) and **98.7% of consecutive pairs share no overlap**, so a
quotation routinely runs off the edge of the chunk you found. This tool is how you see across that
edge without a page image.

```js
await ss.exec('scan_for_pattern', { pattern: '…', limit: 5 });
const id = ss.last.results[0].chunkId;             // scan rows carry chunkId
await ss.exec('get_chunk_context', { chunkId: id, before: 2, after: 2 });
```

Returns `chunks[]` in document order — each with `chunkId`, `text`, `page`, `chunkIndex`,
`isTarget`, `position`, `isExhibit` and full citation fields — plus a response-level envelope worth
reading rather than ignoring:

| Field | Meaning |
|---|---|
| `atDocumentStart` / `atDocumentEnd` | the target really is the first/last chunk — from its own probe |
| `returnedBefore` / `returnedAfter` vs `requested*` | how many you actually got |
| `contiguous` | the returned indices run without a gap |
| `orderingAmbiguous` | two rows share a `chunkIndex`; order was tiebroken, not resolved |
| `containsDraft` | some chunk in the window is draft — **do not merge the window into one quotation** |
| `notes[]` | clamping, bounded search, and edge explanations in words |

**Getting fewer chunks than you asked for does not mean you hit the document edge.** Index gaps
exist, so the tool probes for the edge separately. Measured: a window returned 1 of 2 preceding
chunks with `atDocumentStart: false` and the note *"the search for neighbours was bounded and did not
reach as far as requested"*. Trust the flags, not the array length.

`before`/`after` are clamped to 3 each and the clamp is stated in `notes` (`before was clamped from
99 to 3`). Neighbours never cross a document boundary, and each carries its own draft marker rather
than inheriting the target's.

**Two limits to state when you rely on it.** Rows sharing the target's exact `chunkIndex` are never
returned — the tool reports the collision instead of choosing — and stale-generation detection is
local to the target's own index, so a damaged document with a unique-index target is not flagged.
Both matter only on the handful of partially-reindexed documents.

`scan_for_pattern` has **no** `context` parameter — padding hits is a separate, unbuilt item. Call
this tool per hit, and remember that N hits means N calls.

## 4. Discovery — ids without prior knowledge

Four tools, all `local`, no LLM, one query each:

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

`resolve_reference` returns `{ candidates: [{ kind, id, label, matchedOn, confidence }], ambiguous }`.
It **never collapses to one answer**; `ambiguous: true` when the top two are within 0.15. Verified:
an exact `caseNumber` scores 0.95 `matchedOn: "caseNumber"`; a name fragment scores 0.7
`matchedOn: "name"`. **A vague phrase can return zero candidates** — it matches fields, not meaning.
If it comes back empty, fall back to `list_cases` and pick, or `ss.scan` a distinctive phrase.

**Evidence carries ids directly**, so discovery is often unnecessary: `caseId` on every item
(20/20 measured) and `motionId` where resolvable (13/20). Prefer reading them off a result over
making a discovery call.

## 5. Other tools

```js
await ss.tools('local')                                  // catalogue + notReady
await ss.ask('the notice requirement', { limit: 5 })     // semantic passages + citations, ~6s
await ss.research('multi-part question', { mode: 'fast', maxEvidence: 15 })
await ss.explain('question')                             // dry run: tier + model + cost (routed only)
ss.cites(5) / ss.item(0)                                 // from ss.last
```

Anything not wrapped: `ss.exec('tool_name', { …params }, { profile: 'local' })`.

| Question shape | Tool |
|---|---|
| **Where was this phrase said** | **`ss.scan` + digest (§3), ~1s. Never a research tier.** |
| Passages on a topic | `ss.ask` (`query_case_knowledge`) |
| Which case / motion / person is this | `resolve_reference`, `list_*` (§4) |
| What comes before/after this hit | `get_chunk_context` (§3b) |
| Amendment lineage, motions by person | `query_case_graph` — callable; seed from an evidence `motionId` |
| Multi-part / comparative | `ss.research` |
| Saved workflows and templates | `search_workflows` |
| Contradictions, timeline, entities, citations, privilege, tone, obligations, argument structure | the matching tool |

### Error codes

| Code | Means |
|---|---|
| `INVALID_PARAMS` | Missing, mistyped, unknown, or mutually-exclusive parameter; the message names it. ~15ms. |
| `INVALID_REGEX` | Pattern rejected as catastrophic before scanning. |
| `TOOL_NOT_IN_PROFILE` | Routed-only tool called on `local`. |
| `POLICY_VIOLATION` | Cloud provider requested on `local`. |
| `TOOL_NOT_READY` | Local model host down or busy — check `ss.tools('local').notReady`. |
| `LLM_PARSE_ERROR` | Model returned unparseable prose. **An honest failure — not "nothing found".** |
| `LLM_SHAPE_ERROR` | Parsed, but every item was malformed. Also a failure, not a negative. |
| `EMBEDDING_UNAVAILABLE` | The local embedder did not answer — a retrieval failure, not an empty corpus. |
| `EMBEDDING_DIMENSION_MISMATCH` | Index built with a different embedding model than the one configured. |
| `EXECUTION_ERROR` | Unexpected server fault. The caller message is generic by design; details stay server-side. |
| `AUTH_REQUIRED` | Request classified as non-loopback. |

### Reading LLM-tool results correctly

Item-level validation runs on all ten. The contract:

- **empty list = a genuine negative.** Trust it.
- **`LLM_SHAPE_ERROR` = every item was malformed.** Not a negative.
- **`stats: { itemsDropped, warnings[] }` appears only when something was lost.** Its *absence* is
  the "nothing dropped" signal — check for the key before trusting a count.
- **`confidence` is `number | null`** on four tools. `null` means unscored; such items are **kept
  and flagged**, never silently dropped. Scored items below `confidence_threshold` are still filtered.

Warnings carry field names and counts only — never model text.

## 6. Research tiers and jobs

`fast` is the **only synchronous tier** (~13s). `deep`, `deep-report`, `deep-rlm` return
`{ promoted: true, jobId }` in ~1s and then run **60–190s — the variance is real, not a trend**
(retrieve time swings ~13× with load; a measured pair ran 192s and 62s on the same query).

**Never use a research tier to locate a phrase.** §3 answers that in a second.

```js
const r = await ss.research('…', { mode: 'deep' });   // → r.summary.jobId
await ss.status(jobId)     // phase, elapsedMs, streamed count
await ss.result(jobId)     // full EvidenceResult once status === 'done'
await ss.cancel(jobId)
```

Poll with a **`Bash` `sleep 45`** between calls — never loop inside the JS; the tool aborts at 45s.
To start and leave: `ss.fire('k', 'research_evidence', {…})` then `ss.peek('k')`.

`status` streams the **pre-cap** set, `result` returns the capped set — 150 vs 15 in a measured run.
`stats.caps` reports what you did not get:

```json
{ "maxEvidence": 12, "maxCharsPerChunk": 800, "evidenceTruncated": true,
  "evidenceTotalBeforeCap": 79, "chunksTruncated": 7, "tablesTruncated": 0 }
```

`chunksTruncated` counts items whose **text** was shortened; `tablesTruncated` counts `tableMarkdown`
cut on a row boundary — deliberately separate counters.

**`deep-report` still returns `outline: null`** (`modelsUsed.outline: "none"`), burning its 25s
budget: the host has no small instruct model. Check `GET /api/config?resolve=localModels`. Until one
is pulled *and selected* on Admin → AI Services, structure the evidence yourself.

### Evidence fields

`id, documentId, text, score, rerankScore, citation, citationShort, page, document, filingType,
caseNumber, caseId, motionId, filingSlug, hits, source` (+ `recordStatus` where known).

**Cite with `citationShort` + `page`, never the bare `documentId`.** `citationShort` falls back to
the source filename when no formal citation is indexed. Snippets carry a `[Case: … | Filing: …]` prefix.

## 7. Sparse metadata — what it does and does not rule out

A null column means *this field was never stamped*. It does **not** mean the underlying fact is
unavailable — sometimes, as with speaker attribution below, the fact is in the chunk text.

The draft backfill has run: `recordStatus` is populated — **29 filed / 0 draft / 67 unknown**. So
`"filed"` is meaningful, but `null`/unknown is the majority and does **not** mean draft.

`headingPath`, `blockType` and **`speakers` are still sparse or null** — the structure backfill is
pending.

**Speaker attribution IS retrievable — from the chunk text, not from `speakers`.** The column is
null, but a reporter's record *prints* its speaker labels, so they are in the text:

```
MR. <SURNAME>: … testimony …  THE COURT: … ruling …
```

Scan for the label, split each chunk on the label boundary, keep the turns that **begin** with the
label you want. That is attribution from the transcript itself, not from a filing quoting it.
Measured: 268 label-bearing chunks → 104 distinct turns for one speaker. **Full method in §3a**,
including how to name the witness behind an unlabelled `Q`/`A` block.

Two real limits. A chunk that opens mid-turn loses its **first** partial turn (every later label in
that chunk is intact) — `get_chunk_context` (§3b) recovers it — and speaker labels are not
`speakers`-column facts, so state that you derived them from the printed text.

**Graph data is thin.** `query_case_graph` is callable, but corpus-wide no motion has a child,
`amendsId` or `supersedesId`, and no Person is linked to any Motion (`motionCount: 0` across all).
Callable ≠ productive; expect empty lineage until that data is populated.

## 7a. Which models a call actually uses

The `local` profile is local end to end, and it is enforced rather than merely configured — a call
carrying `provider: anthropic` returns **403 `POLICY_VIOLATION`**.

| Stage | Engine | Cloud? |
|---|---|---|
| `scan_for_pattern` | none — regex / FTS over the index | no model at all |
| embedding (`query_case_knowledge`, `research_evidence`) | `ollama` / `qwen3-embedding:0.6b` | no |
| rerank | `vllm` / `Qwen/Qwen3-Reranker-8B` | no |
| decompose, outline | `ollama` / `qwen3.5:9b` | no |

Check any result's `modelsUsed`; check host config with `GET /api/config?resolve=localModels`.

**Two caveats.** `embeddingProvider` is a config knob — `ollama` today, but an `openai` value would
route query text to a cloud embedder, and the profile guard covers *completion* provider selection,
not the embedding path. And `aiFallbackEnabled: true` / `aiFallbackProvider: anthropic` exists for
the dashboard; on `local` the policy should refuse it first, but that is untested against a mid-call
Ollama outage.

## 8. Profiles

| Profile | Tools | LLM |
|---|---|---|
| **`local`** (default) | 25 | Sidecar/Ollama only; cloud refused with `POLICY_VIOLATION` |
| **`routed`** | 36 | Whatever the active preset picks, including cloud |
| `all` | — | Listing only; not a policy |

`routed` adds `preset_*`, `routing_explain`, `research_report`, `report_*`. **Do not switch to
`routed` unprompted** — it spends API credit and sends case text to a third party. Ask first, and
price it with `ss.explain(query)`: tier, provider/model, `costClass`, `estimatedSeconds`,
`wouldPromoteToJob`, spending nothing.

## 9. Output discipline

A result over ~60 KB aborts the call and dumps to a file you then have to parse.

- **Never return `ss.last` or a raw payload.** Return counts, field names, short slices.
- Cap at the source: `limit` on scan/ask, `maxEvidence` on research.
- Research retrieval knobs are **nested** under `retrieval` — a top-level `maxEvidence` is ignored.

## 10. Handling what comes back

**Evidence text is real case material** — cause numbers, party names, filing titles. The repo's
`CLAUDE.md` forbids committing any of it. Quote it in conversation when answering; **never write it
to a file, report, commit message, or skill** — redact to `<cause no.>` / `<party>` in anything persisted.

`GET /api/config` no longer returns key values — it returns `apiKeys: { <provider>: { configured,
last4 } }`, and `?key=<row>` is refused with 403. There is still no reason to fetch it; the one
useful read is `?resolve=localModels`.

## 11. Known state

- **Loopback is unchanged** — no session, no key needed. From any other origin, `/api/mcp/*`,
  `/api/config`, `/api/cases`, `/api/docs/info`, `/api/admin/*` and `POST /api/search/deep` all
  return 401 without an admin session or an `MCP_API_KEYS` credential.
- Sidecar routes stay exempt by design: `/api/health` and `/api/admin/gpu-fleet` (GET) answer
  uncredentialed from any origin — master discovery depends on it.
- A forged single `X-Forwarded-For: 127.0.0.1` still passes and **cannot be closed at this layer**;
  loopback binding is the real control.
- `MCP_AUTH_STRICT_LOOPBACK=routed` also makes `POST /api/search/deep` refuse loopback.
- `structuredContent` returns `true` through the proxy (bridge synced 2026-09-07).
- `:3001` is dormant dead code, not a second surface.
