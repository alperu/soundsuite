---
name: soundsuite-mcp
description: "Query the Sound Suite / court-lens-mcp case-document engine from a Cowork session — regex phrase search, evidence retrieval, case/motion/person discovery, and deep research jobs. Use when asked to search, cite, or analyse case documents."
---

# Querying Sound Suite

Sound Suite (`court-lens-mcp`) indexes court PDFs and exposes 24 tools in the `local` profile.
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

`ss.scan` (`scan_for_pattern`) is a **true regex scan** as of v6.1. Character classes,
alternation, and mid-word fragments all work — verified `[Uu]nbeknownst` → 37, `nbeknownst` → 37,
`unbeknownst` → 37 on the same corpus. (Before v6.1 the first two returned 0 silently; if you meet
a session or doc that says regex does not work, it is stale.)

Recall is **self-reporting**. Every scan result carries:

```jsonc
{ "results": [...], "strategy": "fts+regex" | "full-scan",
  "candidatePool": 21,        // fts+regex only — how many candidates the keyword pass found
  "scanned": 25560,           // full-scan only — chunks examined before the page filled
  "nextCursor": "…",          // present when more may exist; absent when exhausted
  "warnings": [] }
```

**Two strategies, and the counter-intuitive part: the regex form is often the *more* complete one.**

| Pattern | strategy | warning |
|---|---|---|
| `unbeknownst` | `fts+regex` | *"Keyword recall was capped at 21 candidates; more matches likely exist beyond this page."* |
| `[Uu]nbeknownst` | `full-scan` | *"No literal in this pattern is a whole index token… ran a full regex scan instead."* |
| `nbeknownst` | `full-scan` | *"Keyword recall returned no candidates — ran a full regex scan instead."* |
| `\d{3},\d{3}` | `full-scan` | same as row 2 |

A plain literal takes the keyword path, which **caps its candidate pool** — so the literal search can
be *less* complete than the same word wrapped in a character class, which forces a full scan of all
~36k chunks. Do not assume "simplest pattern = most hits".

**How to read the three warnings:**

- *"Keyword recall was capped at N…"* → **incomplete.** Page with `nextCursor`, or force a full scan
  by making the pattern non-tokenisable (e.g. `[Uu]nbeknownst`).
- *"No literal … is a whole index token"* / *"Keyword recall returned no candidates"* → it already
  fell back to a full scan. Not a problem, just slower.
- `warnings: []` → the keyword pass covered its pool.

**Proving a phrase is absent** — the one result litigation actually needs — requires all three:
`strategy: "full-scan"`, no `nextCursor`, and `scanned` equal to the corpus (~35,890 here). A zero
result from a capped `fts+regex` pass proves nothing. Measured: an absent token scanned 35,890 in
1.8 s and returned no cursor.

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

Bad input now fails loudly instead of lying:

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

**No cursor now means complete, for two reasons that both had to be fixed.** A keyword set the index
cannot reach escalates to a full scan *before* the query runs, and a capped candidate pool escalates
*after* it. So a cursor-free page is exhaustive rather than merely finished.

**Read the warning, not just the count.** A zero over a reachable keyword set with an uncapped pool
now says the absence is **proven, not merely unreached** — that is the wording to quote when you
assert a phrase is absent. Anything else means recall was bounded.

**⚠️ That guarantee has a precondition.** "Reachable" is judged against `FTS_STOPWORDS`, a
hand-maintained mirror of the index's stopword set, plus a three-character floor on keywords. A
stopword missing from that list would be treated as reachable, and the tool would then call a zero
*proven* when recall never ran. The word is trustworthy for ordinary English; for a filing on which
a negative finding actually turns, run the de-tokenised control below as well.

**The check worth doing anyway.** If a scan returns zero, re-run it de-tokenised
(`[Cc]ould not do` → `[Cc]ould [Nn]ot d[o]`). If the two disagree, the zero was never about the
corpus. That trick caught both defects fixed here.

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

**Evidence now carries ids directly**, so discovery is often unnecessary: `caseId` on every item
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
| Amendment lineage, motions by person | `query_case_graph` — now callable, seed from an evidence `motionId` |
| Multi-part / comparative | `ss.research` |
| Contradictions, timeline, entities, citations, privilege, tone, obligations, argument structure | the matching tool |

### Error codes

| Code | Means |
|---|---|
| `INVALID_PARAMS` | Required field missing; the message names it. All ten LLM tools enforce this. ~15ms. |
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

Item-level validation now runs on all ten. The contract:

- **empty list = a genuine negative.** Trust it.
- **`LLM_SHAPE_ERROR` = every item was malformed.** Not a negative.
- **`stats: { itemsDropped, warnings[] }` appears only when something was lost.** Its *absence* is
  the "nothing dropped" signal — so check for the key before trusting a count.
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
Measured: 268 label-bearing chunks → 104 distinct turns for one speaker.

Two real limits. A chunk that opens mid-turn loses its **first** partial turn (every later label in
that chunk is intact), and speaker labels are not `speakers`-column facts, so state that you derived
them from the printed text.

Alternation works — scan for every label in one call. `(MR\.|MS\.|THE COURT)` used to return zero
silently; it now full-scans and returns its hits. If any branch of your pattern reduces to a
stopword, a fragment, or a literal under three characters, the whole pattern takes the linear path
automatically and `warnings[]` says so.

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
| **`local`** (default) | 24 | Sidecar/Ollama only; cloud refused with `POLICY_VIOLATION` |
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
