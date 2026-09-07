# MCP Discovery Tools — Making the Surface Callable Without Prior Knowledge

**Date:** 2026-09-07 · **Commit surveyed:** `931ae89` · **Method:** live probes of the running
instance plus a read of `prisma/schema.prisma` and `src/lib/search/graph-expand.ts`.
**Privacy:** synthetic examples only; no case identifiers, names, or document text reproduced.

---

## 0. The problem in one line

**Every scoped tool requires a UUID, and the MCP surface hands out almost none of them.**

A client can retrieve a passage, read that it belongs to a particular appeal, and still be unable to
run a single case-scoped tool against it — because retrieval returns the *docket number* and the
tools want the *database id*, and nothing maps between them.

This is not a polish item. It is why six tools are hard to call and three are impossible.

---

## 1. What is discoverable today — measured

| Identifier | Required by | Reachable from MCP? |
|---|---|---|
| `documentId` | `extract_entities`, `detect_privilege`, `analyze_tone`, `extract_obligations`, `extract_argument_structure`, `compare_argument_structures` | ✅ **Yes** — every evidence item carries it |
| `caseId` | `detect_contradictions`, `track_claim_evolution`, `analyze_citations`, `reconstruct_timeline`, plus optional scoping on `query_case_knowledge` / `research_evidence` | ❌ **No** — see §2 |
| `motionId` | `query_case_graph` → `amendment-lineage`, `related-motions` | ❌ **No** — nothing enumerates motions |
| `personId` | `query_case_graph` → `motions-by-person` | ❌ **No** — nothing enumerates people |
| workflow / template id | `search_workflows` | ✅ **Yes** — the one tool callable with no arguments |

Probed enumeration routes:

```
GET /api/cases      200  { cases[5] }  id, name, path, caseNumber, jurisdiction,
                                        county, state, country, totalDocuments, createdAt
GET /api/motions    404
GET /api/people     404
GET /api/persons    404
GET /api/entities   404
GET /api/filings    404
GET /api/documents  400  (requires params)
```

Only cases are enumerable at all, and that route is **not exposed as an MCP tool** — I found it by
guessing the path.

---

## 2. Why `caseId` is the sharpest edge

Retrieval returns the human-readable identity and withholds the machine one:

```
evidence fields:  id, documentId, text, score, rerankScore, citation, citationShort,
                  page, document, filingType, caseNumber, filingSlug, hits, source
qck fields:       text, document, page, score, citation, citationShort, filingType,
                  volumeNumber, caseNumber, filingSlug, documentId, blockType
```

`caseNumber` is present in both. `caseId` is in neither.

The only accidental source is `search_workflows`, whose rows carry `caseId` — but only for cases
that happen to have a workflow. On this corpus that yields **2 of 5**.

**The SS-3 fix put this on the critical path.** Before it, `detect_contradictions({})` filtered on
`{caseId: undefined}` and returned a confident analysis of an unnamed scope. Now it correctly refuses
with `INVALID_PARAMS: caseId is required`. That was the right fix — a false positive outranks a
missing answer — but it converts a silent wrong result into a hard block, and there is no supported
way to obtain the missing argument. Four tools are currently unreachable from a clean session.

---

## 3. Why the whole graph subsystem is dead surface

`query_case_graph` has three operations and **all three require a seed id that nothing provides**:

| Operation | Seed | Obtainable? |
|---|---|---|
| `amendment-lineage` | `motionId` | no |
| `related-motions` | `motionId` | no |
| `motions-by-person` | `personId` | no |

Behind it is a real model, not a stub — `Motion` (with `parentMotionId`, `amendsId`, `supersedesId`,
`revisionSeq`), `Person`, `PersonRole` (polymorphic `scopeKind`/`scopeId`), `MotionEvent`,
`MotionAttachment`, `Hearing`, `ReportersRecord` — and a bounded traversal capped at 50 nodes and
4 hops with `caseScope` filtering (`graph-expand.ts`).

`query_case_graph` shows **zero executions** in the registry. That has been read as "untested." The
measured reason is simpler: **it cannot be called.** Amendment lineage — "what superseded what" — is
among the most valuable questions this corpus can answer, and it is sealed behind an id with no door.

---

## 4. Proposed tools

Four discovery tools, all in the `local` profile, all cheap (no LLM, single indexed query), all
returning compact rows rather than full objects. Naming follows the existing `verb_noun` convention.

### 4.1 `list_cases` — the unblocker

```jsonc
{ "name": "list_cases",
  "description": "List indexed cases with their ids. Call this first when a tool needs a caseId.",
  "inputSchema": { "type": "object", "properties": {
    "query":  { "type": "string",  "description": "Optional filter over name, caseNumber, jurisdiction." },
    "limit":  { "type": "integer", "default": 25 } } } }
```

Returns `{ cases: [{ caseId, name, caseNumber, jurisdiction, county, state, totalDocuments, createdAt }] }`.

The data already exists at `GET /api/cases`; this is a thin wrapper plus a `query` filter. Smallest
change with the largest unblock — it makes four tools callable.

### 4.2 `list_motions` — opens the graph

```jsonc
{ "name": "list_motions",
  "inputSchema": { "type": "object", "properties": {
    "caseId":         { "type": "string" },
    "query":          { "type": "string",  "description": "Substring over motion title." },
    "hasAmendments":  { "type": "boolean", "description": "Only motions with children or amends/supersedes pointers." },
    "limit":          { "type": "integer", "default": 25 } } } }
```

Returns `{ motions: [{ motionId, title, caseId, caseNumber, startPage, endPage, filingId,
parentMotionId, amendsId, supersedesId, revisionSeq, documentId? }] }`.

`hasAmendments` matters: it is the natural entry point to `amendment-lineage`, which is the graph's
strongest question. Include `documentId` where the motion maps to one, so a caller can pivot straight
into the document-scoped tools.

### 4.3 `list_people` — opens `motions-by-person`

```jsonc
{ "name": "list_people",
  "inputSchema": { "type": "object", "properties": {
    "query":  { "type": "string",  "description": "Substring over displayName or barNumber." },
    "role":   { "type": "string",  "enum": ["judge", "movant", "respondent", "any"], "default": "any" },
    "caseId": { "type": "string",  "description": "Only people appearing in this case." },
    "limit":  { "type": "integer", "default": 25 } } } }
```

Returns `{ people: [{ personId, displayName, barNumber?, jurisdiction?, roles: [{ role, caseId, caseNumber }], motionCount }] }`.

`motionCount` lets a caller rank by involvement rather than guessing. Derive roles from `PersonRole`
plus the three `Motion` role relations.

### 4.4 `resolve_reference` — the fill-in-the-blanks tool

This is the one that makes the two-call pattern work in practice, because a user never says a UUID —
they say "the interlocutory appeal" or "the receivership motion."

```jsonc
{ "name": "resolve_reference",
  "description": "Map human text to candidate ids. Returns ranked candidates with a confidence and the field that matched. Never guesses a single answer.",
  "inputSchema": { "type": "object", "properties": {
    "text": { "type": "string" },
    "kinds": { "type": "array", "items": { "enum": ["case", "motion", "person", "document"] },
               "default": ["case", "motion", "person", "document"] },
    "limit": { "type": "integer", "default": 5 } },
    "required": ["text"] } }
```

Returns:

```jsonc
{ "candidates": [
  { "kind": "case",   "id": "<uuid>", "label": "<case name>",
    "matchedOn": "caseNumber", "confidence": 0.95 },
  { "kind": "motion", "id": "<uuid>", "label": "<motion title>",
    "matchedOn": "title", "confidence": 0.6, "caseId": "<uuid>" } ],
  "ambiguous": true }
```

Two design rules worth holding to:

- **Never collapse to one answer.** Return candidates with `matchedOn` and let the calling model
  choose, or ask. A discovery tool that silently picks the wrong case reintroduces exactly the
  false-positive class SS-3 #1 just eliminated.
- **`ambiguous: true` when the top two are within ~0.15 confidence.** That flag is what tells a
  well-behaved client to ask the user instead of proceeding.

---

## 5. Schema additions — cheaper than a second call

Discovery tools solve the round trip. Carrying the ids on results avoids it entirely.

| Change | Where | Why |
|---|---|---|
| Add **`caseId`** to `EvidenceItem` and `query_case_knowledge` results | `evidence-mapping.ts`, qck projection | Removes the most common round trip outright. The chunk already knows its case — it returns `caseNumber` from the same row. |
| Add **`motionId`** where a chunk maps to a motion | same | Turns any retrieval hit into a graph entry point. Converts `query_case_graph` from unreachable to incidental. |
| Add **`caseNumber` → `caseId`** to `list_cases` filtering | `list_cases` | The docket number is what appears in evidence; make it the lookup key. |

**The first row is the single highest-value change in this document.** Two fields on a projection
that already selects from the right table, and the discovery round trip becomes optional rather than
mandatory.

---

## 6. The call pattern this enables

Today, a case-scoped question dead-ends:

```
ss.ask('notice requirement')            → passages, caseNumber, no caseId
ss.exec('detect_contradictions', {})    → 400 INVALID_PARAMS: caseId is required
                                        → no supported way to obtain one
```

With §4 and §5:

```
// one call, human words in, ids out
ss.exec('resolve_reference', { text: 'the interlocutory appeal', kinds: ['case'] })
  → candidates[0].id                                    ~20 ms

// second call does the real work
ss.exec('detect_contradictions', { caseId, confidence_threshold: 0.7 })
```

and the common case needs no discovery call at all, because retrieval already carried the id:

```
const r = await ss.ask('notice requirement', { limit: 5 });
const caseId = ss.item(0).caseId;                        // §5
await ss.exec('reconstruct_timeline', { caseId });
```

Graph questions become reachable for the first time:

```
ss.exec('list_motions', { caseId, hasAmendments: true })
  → motionId
ss.exec('query_case_graph', { operation: 'amendment-lineage', motionId })
  → what superseded what
```

---

## 7. Cost, and what to build first

| # | Item | Size | Unblocks |
|---|---|---|---|
| 1 | **`caseId` + `motionId` on evidence and qck results** | **XS** | Removes most round trips; makes the graph incidentally reachable |
| 2 | `list_cases` | S | 4 tools that currently hard-fail |
| 3 | `list_motions` | S | `amendment-lineage`, `related-motions` |
| 4 | `resolve_reference` | M | Human phrasing → id, the actual interaction pattern |
| 5 | `list_people` | S | `motions-by-person` |
| 6 | Gate `/api/cases` | XS | Sits outside the `/api/mcp/*` guard — §8 |

Item 1 first: it is the smallest change and it makes items 2–5 optimisations rather than
prerequisites. Items 2 and 3 together take `query_case_graph` from zero executions to callable.

None of these need an LLM, so all are `local`-profile safe and add no cost per call. Every one should
also be exercised by the SS-3 test pattern — a tripwire asserting the id actually resolves, paired
with one asserting the ambiguous case is reported rather than silently resolved.

---

## 8. One security note while you are in these routes

`GET /api/cases` returns **200 from a forged non-loopback origin**. It is outside the
`/api/mcp/*` guard, like `/api/config`, `/api/admin/*` and `/api/search/deep`. It exposes the case
inventory — names, docket numbers, jurisdictions, counties, document counts.

Lower stakes than the plaintext provider keys on `/api/config`, but it is the same root cause: the
guard is scoped to the MCP path, and the enumeration surfaces sit outside it. If `list_cases` wraps
this route, the wrapper will be gated automatically — the underlying route still will not be.

---

## Appendix — verified facts behind this document

```
tool count                       local 20 · routed 32
tools requiring caseId           detect_contradictions, track_claim_evolution,
                                 analyze_citations, reconstruct_timeline (+2 optional)
tools requiring documentId       6 — all satisfied, evidence carries documentId
query_case_graph operations      amendment-lineage(motionId), related-motions(motionId),
                                 motions-by-person(personId) — none obtainable
query_case_graph executions      0 (registry stats)
empty-params behaviour           400 INVALID_PARAMS naming the field, 10/10 LLM tools
                                 query_case_graph: "motionId is required for operation
                                 'amendment-lineage'" in 16 ms

GET /api/cases                   200 · 5 cases · id, name, path, caseNumber, jurisdiction,
                                 county, state, country, totalDocuments, createdAt
GET /api/cases (XFF public)      200  ← ungated
GET /api/motions|people|persons|entities|filings   404
GET /api/documents               400 (requires params)

evidence fields                  id, documentId, text, score, rerankScore, citation,
                                 citationShort, page, document, filingType, caseNumber,
                                 filingSlug, hits, source          ← no caseId
qck fields                       text, document, page, score, citation, citationShort,
                                 filingType, volumeNumber, caseNumber, filingSlug,
                                 documentId, blockType             ← no caseId
search_workflows                 exposes caseId on workflow rows — 2 of 5 cases

graph models present             Motion (parentMotionId, amendsId, supersedesId, revisionSeq),
                                 Person, PersonRole (polymorphic scopeKind/scopeId),
                                 MotionEvent, MotionAttachment, Hearing, ReportersRecord
graph traversal bounds           MAX_NODES 50 · MAX_HOPS 4 · caseScope filter
```
