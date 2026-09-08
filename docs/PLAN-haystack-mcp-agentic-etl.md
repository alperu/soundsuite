# PLAN — Haystack MCP: model-driven ETL over a case folder

**Date:** 2026-09-08 · **Status:** PLAN ONLY — no code written
**Related:** [`PLAN-scope-editor-haystack-rete.md`](./PLAN-scope-editor-haystack-rete.md) (the UI that
does this by hand), [`tasks/02-graph-aware-retrieval-haystack.md`](./tasks/02-graph-aware-retrieval-haystack.md)
(why the graph matters for retrieval), [`tasks/06-mcp-two-profiles.md`](./tasks/06-mcp-two-profiles.md)
(the profile/policy model any new tool must fit)

No case names, docket numbers, party names or file names appear in this document.

---

## 1. The ask

> Haystack MCP should be able to check the folder with Claude Desktop and create a case in the
> database, create a motion, notice, whatever it has, link the tags, start the embedding process,
> update tags — so the whole ETL process will be done with this model.

And the delivery vehicle:

> On Claude Desktop we will have an ETL skill. They drop a folder and say *"ingest this folder into
> Sound Suite"*, and our Haystack MCP calls handle it.

Concretely: point the model at a directory of court PDFs and have it end with a populated,
*connected* case — documents indexed, entities materialised, kinds assigned, responses linked to the
motions they answer, tags filled — with no human doing the mapping by hand. Driven by a skill
(§4.5), over custom Haystack ops (§6), behind a review gate (§7).

## 2. Why this is worth building now

The blunt reason: **the linking model already exists and has never been used.**

`PLAN-scope-editor-haystack-rete.md` established that `TAG_SPEC_BY_KIND` declares the link slots
with working ref pickers — `respondingTo` (a response → the motion it answers) and `replyingTo`
(a reply → the attachment it answers) — and that the shipped tag panel renders them. Its words:
**"0 rows have exercised it."** The full vocabulary is eleven slots (§9.1); these two are the ones
that carry the docket's argument structure, and they are empty.

The current corpus bears that out:

| Entity | Rows |
|---|---|
| Case | 5 |
| Filing | 94 |
| Motion | 60 |
| MotionAttachment | 39 |
| Person | 20 |
| MotionEvent | 0 |
| PersonRole | 0 |
| Hearing | 0 |

So the graph is a skeleton. `query_case_graph` is callable and unproductive — the skill already warns
that no motion has a child or an amendment link and no person is linked to a motion. Every downstream
feature that wants structure (graph-aware retrieval, cascade scope selection, lineage) is blocked on
data entry that nobody will ever do by hand for hundreds of filings.

**That is the actual bottleneck, and it is judgment work at volume — precisely what a model is for.**

A second reason: the mapping work is currently gated on one person's attention, and it is the kind
of work where being 90% done is worth much more than nothing. An agent that connects the obvious
cases and flags the ambiguous ones changes the economics.

## 3. What already exists

The good news is that almost every primitive is built. Nothing here proposes a new storage model.

### 3.1 Read surfaces

| Surface | What it gives |
|---|---|
| `GET /api/scope/graph` | **The whole structure in one payload** — cases → filings → documents with per-filing connectivity refs, `primaryKind`, `entityKinds`, doc counts. This is what `/scope?tab=editor` renders. |
| `POST /api/haystack/read-grid` | Plain-JSON rows for a compiled filter, using the modern query pipeline. |
| `POST /api/haystack/[op]` | The Haystack protocol server — `about`, `ops`, `libs`, `defs`, `filetypes`, `nav`, `read`, `close`, `commit`. Hayson wire format. Its own header calls it *"peer to MCP"*. |
| `/api/scope/unfiled`, `/api/scope/unconnected`, `/api/scope/filing-documents` | The existing work queues the editor drives from. |

### 3.2 Write primitives

- `commitEntity` (`src/lib/haystack/commit.ts`) — the single entity write path, and **not a clean
  one**: a write through it can leave two disagreeing sources of truth for the same edge (§8.5).
  Consolidating callers onto it without the guarded wrapper first would spread that, not contain it.
- `splitPatch` routes any key not in `NON_TAG_COLUMNS` into the **tags JSON**, so the tag bag is open
  and no migration is needed to add a slot.
- `ensureMotionForFiling`, `ensureMotionAttachmentForFiling`, `ensureReportersRecordForFiling`,
  `ensureClerksRecordForFiling` (`src/lib/haystack/ensure-filing.ts`) — materialise the entity row
  that a Filing implies. **Genuinely idempotent, and structurally so**: each keys the new row on the
  Filing's own primary key, so a duplicate is impossible by construction rather than by luck; each
  reads first, and each catches a create failure, re-reads, and returns the winner of a concurrent
  race. The attachment helper wraps its two creates in one transaction so a failure cannot orphan the
  shadow parent. The one caveat is staleness, not duplication: `title`, `caseId`, `revisionSeq` and
  `documentId` are copied at creation and never re-synced.
- `refs.ts` — ref storage, `synthesizeRefsFromColumns`, origin derivation, label caching.

### 3.3 Ingestion — and three corrections to how it is usually described

An earlier draft of this section described `FileWatcher → JobQueue → IngestionPipeline` with retries.
All three parts of that are wrong, and each changes the design.

**Dropping a folder does not ingest it.** The watcher creates Document rows with status
**`DISCOVERED`**, and *nothing auto-promotes them* to `QUEUED`. Promotion is a separate, deliberate
step. The project `CLAUDE.md` still documents this as `QUEUED` and is stale — worth fixing
independently of this plan, because it has probably misled more than one reader.

| Bucket | Count |
|---|---|
| Documents total | 864 |
| **`DISCOVERED` — never entered the pipeline** | **768** |
| `INDEXED` | 96 |
| …of those, with a `parserVersion` | 22 |
| …without | 74 |

So the corpus is not "mostly ingested with thin structure". **It is 89% un-ingested**, and of the
small ingested slice, three quarters predate structured parsing. That reframes the whole exercise:
the first useful thing an ETL skill does is not linking, it is *noticing that 768 documents were
discovered and never processed*.

**`JobQueue` is vestigial.** It is constructed and registered, but nothing enqueues into it on the
live path; its own constructor comment says it is kept for status monitoring only. The real consumer
of `QUEUED` documents is `src/services/parsing-worker.ts`. Do not build against `JobQueue`.

**There is no retry.** `maxRetries` is declared and defaulted in the parsing worker but never read. A
single pipeline failure sets `ERROR` with a message, permanently. The one exception is worse than no
retry: an OCR-not-GPU-ready error requeues the document and pauses *all* claims process-wide for 30
seconds, with no attempt counter — an unbounded soft loop rather than a bounded retry.

Claiming is genuinely atomic, though: the worker peeks the oldest `QUEUED` row and issues a
conditional update guarded on the status, so two workers cannot double-claim. Concurrency is the
`parsing.workerCount` config key, default 1.

**Registering a directory means creating a Case.** `WATCH_PATHS` does not feed the watcher — it is
read only by an admin display route. The live watcher is built from `Case.path` rows, so
`POST /api/cases` with a folder path *is* the registration, and it returns 409 if that path is
already bound. Case association is a naive prefix match over the watch-path array, so **nested case
folders resolve to whichever entry comes first** — a real hazard for a corpus with a case inside a
case.

Deduplication is solid: streamed SHA-256 as a unique key, a second lookup by path for re-fired
events, and a heal path that repoints a record when the hash matches but the stored path is dead —
which is what makes cloud-sync renames survivable.

### 3.4 The gap

**MCP has zero coupling to any of it.** Grepping `src/lib/mcp` for `haystack`, `hayson`, `kysely` or
the legal repo returns nothing. The two surfaces were built as peers and never joined. There is no
tool through which a model can create a case, materialise an entity, or write a ref.

## 4. The core design decision

**Do not build `do_everything(folder)`.**

The ETL has two kinds of stage, and they want opposite treatment:

| | Deterministic stages | Judgment stages |
|---|---|---|
| Examples | hash, dedup, text extract, OCR, chunk, embed, index | which kind is this filing; what does it respond to; who is the movant; is this a draft |
| Already solved? | **Yes** — the ingestion pipeline | **No** — done by hand in the editor, or not at all |
| Should the model drive it? | **Mostly no** — it is a worker pipeline and an agent poking it adds failure modes. But it has *no retry* (§3.3), so "observe and re-drive the failures" is a real job the model can do. | **Yes.** This is the whole point. |
| MCP's job | *start it and observe it* | *expose the work queue and accept decisions* |

Building one mega-tool collapses this distinction and produces something that is slow, unresumable,
and impossible to audit. The right shape is a **work-queue protocol**: the model asks what needs
deciding, decides, writes the decision, and asks again. Each step is small, idempotent and logged.

This also solves resumability for free. A folder of 200 filings will not finish in one context
window. If the state lives in the database and the queue is derived from it, any session can pick up
where the last one stopped.

## 4.5 The delivery vehicle: an ETL skill on Claude Desktop

The operator's framing, and it resolves what the product actually is:

> On Claude Desktop we will have a skill — an ETL skill. They drop a folder and say *"ingest this
> folder into Sound Suite"*, and our Haystack MCP calls handle it.

So there are three layers, and keeping them separate is what makes this tractable:

| Layer | Holds | Lives in |
|---|---|---|
| **The ETL skill** | the *procedure* — the loop, the order, when to stop, when to ask | `skills/soundsuite-etl/SKILL.md`, beside the existing `soundsuite-mcp` skill |
| **The MCP bridge** | *exposure* — which ops are visible, plain JSON in and out, provenance stamping | `src/lib/mcp` |
| **The custom Haystack ops** | *capability* — one operation each, idempotent, validated | `src/app/api/haystack/[op]` |

**The skill is the orchestrator; the ops are the primitives.** Every branch in §5's loop belongs in
the skill as prose, not in an op as control flow. That is what keeps each op small enough to test and
safe enough to expose, and it is why §4 rejects a `do_everything` call: the loop lives in the skill,
where it can be read, corrected, and versioned without a deploy.

This also settles the resumability question. The skill re-enters the loop by calling `ssWorklist`,
and the worklist is derived from the database rather than from session memory. A second session on
the same folder picks up exactly where the first stopped, with no handoff state.

**One trigger phrase, many turns.** "Ingest this folder" is not one call. The skill should say so
plainly up front, report progress per stage, and stop at the review gate rather than pushing through
it — the operator asked for an ETL run, not for unattended writes to litigation records.

### What the skill must carry

Written as guidance for the person who writes it, not as the skill itself:

- **The order of operations**, because several steps silently no-op if run early: entity
  materialisation before linking, ingestion before tag extraction, tag extraction before the parts of
  linking that depend on dates.
- **The stop conditions.** An empty worklist is the good one. A worklist that stops shrinking across
  two passes is the bad one, and means something needs a human.
- **What "done" means**, and it is not "no errors". It is: every filing has an entity row, every
  non-motion filing has its defining slot filled or an explicit "no candidate" verdict, and the
  survey shows no unindexed file.
- **The refusal.** The skill must not fill a slot it cannot evidence. A blank with a reason is a
  result; a guess is a defect that later gets cited.
- **Cost and time honesty.** A large folder is many model calls. The skill should say what it is
  about to do before it does it.

## 5. The ETL loop

The operator's own sequence, which is the authoritative one:

> When a folder is added it will open the PDF and say *this is case A*, and register that folder as a
> case. Sound Suite can now see all the files in that folder with the case number. We need the
> Haystack model to create a case folder that shows in case management. Then Claude Desktop chooses
> which files to add, and as it adds them it tags whether it is a motion or a notice. Or it passes
> the file with an `auto` parameter and our system checks the PDF itself — if it is a notice, it adds
> it as a notice. Then Claude Desktop can ask Sound Suite to parse the clerk and personas, and from
> there start linking motion to notice, motion to reply.

```
  1 IDENTIFY   ssIdentifyCase(path)            read a PDF, return the case identity
                 ↓                             ⚠ THE ONE REAL GAP — see §5.1
  2 REGISTER   ssCaseEnsure(...)               create the Case; this IS the folder
                 ↓                             registration, and it appears in
                                               case management immediately
  3 SURVEY     ssFolderSurvey(caseId)          every file now visible under the case
                 ↓
  4 SELECT     ssAddFilings(caseId, files[],   Desktop CHOOSES which files to add,
               kind | 'auto')                  and tags each as it adds it
                 ↓                             'auto' → the existing 3-tier detector
  5 INGEST     ssPromoteDiscovered(...)        DISCOVERED → QUEUED (§3.3)
               ssIngestStatus(caseId)          poll; ERROR is terminal, no retry
                 ↓
  6 PARSE      ssFillTags(caseId)              clerk, dates, judge/movant/respondent
               ssPersonaExtract(...)           personas, propose-then-confirm
                 ↓
  7 LINK       ssWorklist(caseId)              what still has an empty defining slot
               ssLinkPropose / ssLinkConfirm   motion→notice, motion→reply
```

**Steps 2, 4, 5, 6 all exist in some form.** Step 7 is the new work (§6.6). Step 1 is the gap.

### 5.1 The gap: case identity comes from the folder name, not the PDF

Today `POST /api/cases` derives the case from **`parseCaseFolder`**, a regex over the *folder
basename* expecting `Case Title - Case-Number`. It never opens a document. If the folder is named
anything else, the case number is null and the case is named after the directory.

The operator's step 1 — *open the PDF and say this is case A* — **does not exist.** It is the one
genuinely new capability in the whole sequence, and it is small: the caption block on the first page
of nearly any filing carries the court, the cause number and the parties.

Design notes for `ssIdentifyCase`:

- **Read before write.** It returns a proposed identity with the excerpt it came from, and writes
  nothing. Registration is step 2, and a human or the skill decides.
- **Sample, don't scan.** The first page of a handful of documents is enough; reading every PDF in a
  folder to name it is waste.
- **Disagreement is a result, not an error.** If sampled documents yield two different cause numbers,
  that means the folder holds more than one case — which the nested-folder hazard in §3.3 says is
  already possible. Report both rather than picking one.
- **Reuse, don't rebuild.** The detector chain in step 4 already extracts header text from a PDF; the
  caption parse belongs beside it.

### 5.2 `auto` is already built

The operator's alternative — *pass the file with an `auto` parameter and our system checks the PDF* —
maps onto `POST /api/cases/[id]/detect-filing`, which is a working three-tier chain:

1. **Redis cache** — instant when a background scan already classified the file.
2. **Regex** over filename and header text — fast, handles the common shapes.
3. **Semantic classification** against LanceDB embeddings — accurate, slower.

It returns `filingType`, `title`, `confidence` and `source`, so a caller can see *which* tier decided
and how sure it was. `classifyFilingEntityKind` then maps that filing type to the entity kind, and
the `ensure*ForFiling` helpers materialise the row.

**So `auto` is a complete chain today: detect → classify → materialise.** `ssAddFilings` should take
`kind: 'auto'` and walk exactly that path, surfacing `confidence` and `source` in its result so the
skill can decide whether to accept it or escalate to reading the document. Low-confidence auto
results should land in the worklist, not in the graph.

### 5.3 Why the Haystack path is the right one for case creation

**The plus button on `/case-management` already does exactly this.** Its handler builds a patch of
`name`, `caseNumber`, `path`, `jurisdiction`, `county`, `state`, `country` and sends
`PUT /api/haystack-proxy/commit` with `{ id: 'new', kind: 'case', patch }`. The proxy is the
same-origin, skip-auth route over the same dispatcher.

`POST /api/cases` is **already marked deprecated in favour of that path** and forwards to
`commitEntity` anyway; its folder-name parsing survives only as a convenience for the legacy UX.

So the operator's instinct — *we need the Haystack model to create the case* — is not a change of
direction. **It is already how the button works.** `ssCaseEnsure` is the same call made in-process,
and the case appears in case management immediately because it is the same row the UI lists.

## 6. Architecture: custom Haystack ops, with MCP as a thin bridge

The operator's constraint, and it is the right one: **"Haystack model, meaning custom Haystack ops."**

So the unit of work is not a bespoke MCP tool. It is a **custom op on the existing Haystack server**,
with the MCP layer as a generated bridge over it. One implementation then serves the Haystack HTTP
API, the browser tag panel, and Claude Desktop alike.

The existing route is already built for this:

- `SUPPORTED_OPS` is a const tuple, and `HANDLERS` is typed `Record<Op, …>`, so **adding an op
  without a handler is a compile error**. The file's own comment says this replaced a `switch` that
  could silently fall through.
- **`opOps()` generates the self-description grid from `SUPPORTED_OPS` automatically.** A new op
  advertises itself the moment it is registered — which is exactly what an MCP bridge needs to
  enumerate tools.
- `dispatchHaystack` is shared, and already supports `skipAuth` for a same-origin caller. The MCP
  server should call it **in-process with `skipAuth`**, never over HTTP to itself.
- Auth for external callers is a bearer key (`HAYSTACK_API_KEY`, falling back to `MCP_API_KEY`).

**Adding a capability is therefore: name it in `SUPPORTED_OPS`, write a handler, and it appears
everywhere.** That is a materially smaller and safer change than nine hand-written MCP tools, and it
keeps the Haystack server as the single source of truth for what the system can do.

### 6.1 The one gap in the bridge

`opOps()` currently emits only `name`, `def` and `dis` per row. **An MCP bridge needs an input schema
per op to generate a tool definition.** So the ops grid must be extended with a parameter
description — a `params` column carrying names, types and required-ness, or a per-op `def` resolvable
through `defs`.

This is the single prerequisite for the whole design, and it is small. Get it right once and every
future op is exposed to MCP for free.

### 6.2 Naming

Vendor ops should be prefixed so they never collide with a future standard op — `ssWorklist`,
`ssCaseEnsure`, `ssIngestStart`, `ssLinkPropose`, `ssLinkConfirm`. The prefix also makes it trivial
for the bridge to decide which ops to expose and which to withhold.

### 6.3 The op surface

Each op below becomes one MCP tool through the bridge, named as the op. Profiles and gating per §7.

**Read / observe — safe, `local` + `routed`**

| Op | Purpose |
|---|---|
| `ssFolderSurvey` | Files on disk vs Documents in the database, matched by SHA-256. Returns new / known / errored / orphaned. **Writes nothing.** |
| `ssScopeGraph` | The case structure. Summary by default with drill-down by case — see §8 on why this cannot be a passthrough. |
| `ssWorklist` | The judgment queue: what still needs a kind, a link, or a tag. The single most important tool here. |
| `ssIngestStatus` | Per-document status counts and the errored list. |
| `defs` (standard op, already present) | The tag vocabulary and which slots each kind accepts, so the model writes valid patches instead of guessing. |

**Write — gated, see §7**

| Op | Purpose |
|---|---|
| `ssCaseEnsure` | Find-or-create a Case. Idempotent on docket number. |
| `ssPromoteDiscovered` | `DISCOVERED` → `QUEUED` for a case, optionally a subset. **The step nobody realises is manual**; 768 documents are parked here. Idempotent. |
| `ssRequeueErrored` | Re-drive terminal `ERROR` documents. The parsing worker has no retry, so without this a transient failure is permanent. Must carry its own attempt cap — see the unbounded OCR loop in §3.3. |
| `ssEntityEnsure` | Materialise the Motion / MotionAttachment / record row a Filing implies. Wraps `ensure-filing.ts`. Idempotent. |
| `commit` (standard op, already present) | Write tags and refs for one entity. Wraps `commitEntity`. The one genuinely dangerous tool. |

**Deliberately excluded from the bridge:** any op that deletes, any op that bulk-writes without
enumerating what it will touch, and — critically — **`commit` must not be bridged raw.** The standard
commit op accepts an arbitrary patch, and §8.5 shows a patch is a loaded weapon: nulls delete tags,
empty strings null columns, and `caseRef` moves a filing to another case. The bridge exposes a
narrowed `ssCommit` that validates the patch against `TAG_SPEC_BY_KIND`, rejects the destructive
shapes, stamps provenance, and forwards one entity at a time.

That is the general rule for the bridge: **an op being registered does not mean it is exposed.** The
`ops` grid drives discovery; an explicit allowlist drives exposure.

## 6.4 Should *everything* go through Haystack ops?

The operator's proposal:

> How about we rewrite Sound Suite to use Haystack ops to create cases, add motions etc — or wrap all
> existing functions in it.

**Wrap, do not rewrite.** And for entity writes, the convergence has already happened by itself —
which is the strongest argument that this is the right direction.

### Where it is already true

| Caller | Path |
|---|---|
| The case-management plus button | `PUT /api/haystack-proxy/commit`, `kind: 'case'` |
| `POST /api/cases` | deprecated; forwards to `commitEntity` |
| The tag panel | the commit path |
| The tag-fill pipeline | imports `commitEntity` directly |

Four independent surfaces, one write path. Finishing this is mostly **deleting duplicate routes, not
building new ones.**

### Where it is a poor fit, and why

Haystack is a **data** protocol: a grid in, a grid out, request and response. Three parts of Sound
Suite do not have that shape.

1. **Long-running work.** Promoting and parsing 768 documents is not a request/response. Haystack
   standardises no job handle, so an op has to invent one — return a job id, poll a status op. That
   is fine, but it is *our* convention riding on their protocol, and it should be designed once and
   used everywhere rather than improvised per op.
2. **Streaming and progress.** The existing change feed is server-sent events and the pipeline
   publishes progress over Redis. Neither belongs in a grid. Leave them where they are and let an op
   report a *snapshot*.
3. **Binary payloads.** Page images, PDFs and exhibit files have no business in Hayson. Those routes
   stay as they are.

### The factoring that makes "everything is an op" true without hurting

**An op handler should be a thin adapter over a plain TypeScript function.**

```
  internal callers ──────────────┐
                                 ▼
  HTTP op  ──► adapter ──►  plain function  ──►  Prisma / LanceDB
  MCP tool ──► adapter ──►       ▲
                                 └── the single implementation, no Hayson
```

Internal callers keep calling the function and never pay the Hayson tax. External callers — the
Haystack API, the browser proxy, and the MCP bridge — all arrive through the adapter. "Everything
goes through ops" then means *everything crosses the boundary through ops*, which is the property
actually worth having: one place to validate, one place to stamp provenance, one place to enumerate
what the system can do.

This is also the only version that is cheap. Rewriting working code to change its calling convention
buys nothing and risks a great deal.

### Worked example: reading a case returns a folder-status grid

The operator's illustration, and it is the one that makes the whole approach click:

> For example, when reading a case it would return a grid of folder status, with a POST call on that
> case, as a grid.

That is exactly right, and it is a better answer than the one this plan gave earlier. A Haystack grid
is **rows plus meta**, so a single read can carry both the summary and the detail:

```jsonc
// ssReadCase  →  one grid
{
  "_kind": "grid",
  "meta": {                       // case-level truth, cheap to read
    "case": "@<id>", "dis": "…", "caseNumber": "…",
    "path": "/…",
    "discovered": 768, "indexed": 96, "errored": 0,
    "unconnected": 41,            // ⚠ NOT computable today — see below
    "structured": 22              // indexed WITH a parserVersion
  },
  "rows": [                       // per-file detail, paged
    { "doc": "@<id>", "dis": "…", "status": "DISCOVERED", "filing": null,  "kind": null },
    { "doc": "@<id>", "dis": "…", "status": "INDEXED",    "filing": "@<id>", "kind": "notice",
      "parserVersion": "…", "refs": { "respondingTo": "@<id>" } }
  ]
}
```

**Three things fall out of this, and each solves a problem raised earlier in this plan.**

1. **The payload problem (§8) is solved by the format itself.** Meta carries the counts, rows carry
   the detail and page. The skill reads meta to decide whether to look further. No bespoke
   summary-versus-full mode is needed — that distinction is what grid meta *is for*.
2. **Status stops being a special endpoint.** Ingestion progress, connectivity and structure coverage
   are just columns. `ssIngestStatus` and much of `ssFolderSurvey` collapse into `ssReadCase` with
   different column projections, which is fewer ops to design, document and secure.
3. **One shape for every reader.** The same grid serves the browser, the Haystack API and the MCP
   bridge. The bridge's only job is Hayson → plain JSON.

**One field in that example is aspirational.** `unconnected` is the operationally interesting number
and **nothing on the server can currently produce it**: the existing endpoint uses all-refs-empty
semantics (§9.2) and the defining-slot-empty logic still lives in a browser component. Either lift
that logic first, or leave the field out until it is real. A meta field that looks authoritative and
is not is worse than an absent one.

Two design rules for these grids:

- **Meta is a summary, never a sample.** A count in meta must be the true count for the whole case,
  even when rows are paged — otherwise a skill that reads only meta draws a wrong conclusion, which
  is the same class of defect as the recall failures in reports v8 and v9.
- **Every operational column is nullable and says why.** `parserVersion: null` means *ingested before
  structured parsing*, which is different from *not ingested*. The status column carries that
  distinction; the grid should never make the reader infer it.

### ⚠️ Sequencing: validation must land first

Consolidating on `commitEntity` **also consolidates its footguns.** Today the hazards in §8.5 —
null-deletes-a-tag, empty-string-nulls-a-column, `caseRef` moves a filing non-transitively, ref tags
orphaning their columns — are reachable from a handful of callers. Make it the universal path and
they are reachable from everywhere, including an agent.

**So the validation layer is a prerequisite for the consolidation, not a follow-up to it.** Build the
guarded wrapper first, migrate callers to it second. Doing it in the other order widens the blast
radius of every bug in §8.5 before the guard exists.

### Recommended strangler sequence

1. **New capability lands as an op only.** No new route that bypasses the op layer.
2. **Build the guarded write wrapper** (§8.5 rules) and point the op layer at it.
3. **Migrate existing callers** to the op layer one at a time, starting with the ones that already
   import `commitEntity`.
4. **Delete a duplicate route only once nothing calls it** — verified by grep, not by assumption.
5. **Leave binary, streaming and SSE routes alone.** They are not data ops and never will be.

Steps 1 and 2 are worth doing regardless of whether the rest of this plan proceeds.

## 6.5 Whole-app migration: two verbs for every page, admin included

The operator's decision, and this section takes it as settled rather than re-arguing it:

> We need this feature — Haystack `commit` to add, Haystack POST `read` to read, based on case
> record. We are basically turning the app into the Haystack model. We should have this model for all
> pages including the admin pages.

**Two verbs.** `commit` writes, `read` reads, and everything else is a projection or a job. §6.4's
adapter factoring is what makes this affordable: internal callers keep calling plain functions, and
only the boundary speaks Hayson.

### The scale, stated honestly

| | Count |
|---|---|
| API routes | 167 |
| Pages | 24 |
| Admin API routes | 38 |

This is a program, not a task. It needs a ledger — a checked list of routes with their target bucket
and migration state — or it will stall half-done, which is the worst outcome because two conventions
then coexist indefinitely.

### Every route lands in one of four buckets

| Bucket | Becomes | Examples | Notes |
|---|---|---|---|
| **1. Entity CRUD** | `commit` + `read` | case, motion, attachment, person, court, hearing | **Already converging** (§6.4). Mostly deletion of duplicate routes. |
| **2. Derived reads** | `read` with a filter → grid with meta | folder status, connectivity, ingest progress, filing lists, worklists | The §6.4 worked example. Meta carries totals, rows carry detail. This bucket is where most of the 167 live. |
| **3. Jobs** | a custom op returning a **job handle**, plus a status op | promote, parse, reindex, backfill, tag-fill, persona extract | Needs the one convention decided up front (§13.2). |
| **4. Not ops, and never will be** | unchanged | PDFs, page images, exhibit binaries, SSE change feeds, Redis progress, auth/login/session | Forcing these into grids buys nothing and loses streaming. Say so explicitly so nobody "finishes" the migration by breaking them. |

### Admin pages are the sharp end

Admin is where this gets genuinely dangerous, and it is worth being blunt about why.

Making an operation an op makes it **enumerable and callable** — that is the entire point, and it is
exactly what you do not want for `clean-orphans`, `gpu-reset`, `queue/clear`, `sessions/[id]/revoke`,
`users/[id]` or `filings/reclassify`. Today those are obscure endpoints behind an admin session.
After migration they are rows in the `ops` grid with documented parameters.

Three rules, and the first is already stated in §6 but bears repeating because admin is where it
matters most:

1. **Registration is not exposure.** The `ops` grid drives discovery; a separate allowlist drives
   what the MCP bridge surfaces. **No destructive admin op is ever bridged.**
2. **Admin ops carry their own profile.** They are not `local`, not `routed`, and not reachable with
   an MCP key. They keep the admin-session gate they have now — migration must not become a quiet
   privilege widening.
3. **Read-only admin first.** `server-info`, `system-info`, `action-logs`, `watch-paths`,
   `filing-types`, `reranker-health` are pure reads and make good early migrations. The destructive
   ones go last, or never.

### The payoff, concretely

- **One validation point.** Every write passes the §8.5 guards once, not per route.
- **One provenance point.** Agent-versus-human attribution stops being per-feature.
- **One enumeration point.** `ops` becomes a live inventory of what the system can do, and `defs`
  becomes live documentation of its vocabulary. Both are generated, so neither goes stale.
- **One bridge.** MCP, the browser proxy and the external API stop being three integrations.

### The honest cost

Hayson at the boundary is verbose, and a half-finished migration means two conventions in the tree
for months. The adapter factoring contains that — an unmigrated route still works, because it calls
the same plain function the op calls — but it does not eliminate it. **Budget for the ledger, and
treat "delete the duplicate route" as part of each migration rather than a cleanup phase that never
comes.**

## 6.6 UI parity — the actual surface to expose

The operator's framing, and the right one: *"We use the UI at `/case-management` to add cases, and
the case dashboard to embed things. We want to be able to do all of that via Haystack MCP."*

So this is not a greenfield capability. **Almost every step already has an HTTP endpoint that the UI
drives.** The job is to expose that operator surface to the model behind a safety layer, not to
invent new machinery.

| UI action | Endpoint | Method | Proposed tool | Risk |
|---|---|---|---|---|
| List / create a case | `/api/cases` | GET, POST | `ssCaseEnsure` | low — idempotent if matched on docket |
| Update / delete a case | `/api/cases/[id]` | PATCH, DELETE | update only; **never expose DELETE** | high |
| Register a watched folder | — | — | **folds into `ssCaseEnsure`** — the watcher reads `Case.path`, so creating the case *is* the registration. `/api/admin/watch-paths` is display-only; `/api/cases/[id]/watch` is an SSE change feed, not a registration | — |
| Rescan a folder | `/api/cases/[id]/rescan` | POST | `ssIngestStart` | medium — cheap to repeat, but enqueues work |
| Upload files | `/api/cases/[id]/upload` | POST | out of scope for v1 — the model is not the file transport | — |
| List files / documents / filings | `/api/cases/[id]/files`, `/documents`, `/filings` | GET | `ssFolderSurvey` | none |
| Detect a filing | `/api/cases/[id]/detect-filing` | POST | `ssDetectFiling` | low |
| Auto-filing toggle | `/api/cases/[id]/auto-filing` | GET, PUT | expose GET; PUT is a policy change | medium |
| Filing queue | `/api/cases/[id]/filing-queue` | GET | folds into `ssWorklist` | none |
| **Fill tags (LLM extractor)** | `/api/cases/[id]/fill-haystack-tags` | POST | `ssFillTags` | **high — see below** |
| Revert a tag fill | `/api/cases/[id]/fill-haystack-tags/revert` | POST | `ssFillTagsRevert` | the undo that makes the above tolerable |
| Parse / fix paths | `/api/cases/[id]/parse`, `/fix-paths` | POST | maintenance; expose read-only status first | medium |
| Re-index a document | `/api/documents/[id]/reindex-pages` | POST | `ssReindexDocument` | medium — heavyweight, publishes stage progress |
| Clear a document's index | `/api/documents/[id]/clear-index` | POST | **do not expose** | destructive |
| Document structure / outline / chunks | `/api/documents/[id]/structure`, `/outline`, `/chunks` | GET | read tools | none |
| Ingestion progress | `/api/documents/partial-status` | GET | `ssIngestStatus` | none |
| Clear the queue | `/api/queue/clear` | POST | **do not expose** | destructive, global |

### Personas and courts — already Haystack kinds

The operator named two more pages that must be in scope, and both map onto kinds the write path
already knows: `person` (required on create: `displayName`) and `court` (required: `name`). `Court`
is also a ref target, so `judgeRef` and friends resolve through it.

| UI action | Endpoint | Method | Proposed tool | Risk |
|---|---|---|---|---|
| List / create a persona | `/api/personas` | GET, POST | `ssPersonEnsure` | low |
| Read / update / delete a persona | `/api/personas/[id]` | GET, PUT, DELETE | update only; **never expose DELETE** | high |
| Role bindings for a persona | `/api/personas/[id]/roles` | — | `ssPersonRoles` | medium — `PersonRole` has 0 rows |
| **Propose personas from a document or motion** | `/api/personas/extract` | POST | `ssPersonaExtract` | **prior art — see below** |
| Confirm a batch of proposals | `/api/personas/extract/bulk-confirm` | POST | `ssPersonaConfirm` | the approval gate |
| Merge duplicate personas | `/api/personas/merge` | POST | **do not expose in v1** | destructive, hard to undo |
| Manual define (admin) | `/api/personas/admin/manual-define` | POST | not for agents | — |
| List / create a court | `/api/courts` | GET, POST | `ssCourtEnsure` | low |
| Read / update / delete a court | `/api/courts/[id]` | GET, PUT, DELETE | update only; **never expose DELETE** | high |
| Courts a person appears in | `/api/people/courts` | GET | read tool | none |

**`/api/personas/extract` plus `/extract/bulk-confirm` is the propose-then-apply pattern from §7.3,
already implemented.** It takes a document or a motion, runs extraction across every linked document,
merges candidates with dedup so one person seen in several documents collapses into a single
proposal, pre-scopes the role bindings, and waits for a bulk confirm. That is the exact contract this
plan proposes for linking, shipped and working for people.

### The finding that changes the plan

**`fill-haystack-tags` is already an LLM-driven tag extractor.** It loads filing targets and chunks,
builds a prompt, extracts fields, resolves or creates people, applies deterministic detectors for
signature dates and clerk references, and writes through `commitEntity`. It has a companion
`/revert`.

So "read the PDF and add tags for it" — a large part of the original ask — **is built**.

**And it provably cannot link.** Its allowed field list is exactly `filedOn`, `receivedOn`,
`judgeRef`, `movantRef`, `respondentRef`, `reporterRef`, `fileRef`, `signedOn`, `clerkRef` — dates,
people and the document pointer. **Zero structural slots.** Not one filing-to-filing edge is
reachable through it.

That is the gap, stated precisely: **linking a response to the motion it answers.** The eleven-slot
vocabulary in §9.1 is where the graph is empty, and `respondingTo`, `replyingTo`, `resolves` and
`orderRef` have no column at all — so those edges live or die entirely in the tag bag, where a single
null erases them without trace.

That sharpens the whole plan:

- **Phase 1–3 are mostly wrapping**, and now demonstrably so: the endpoints exist and the UI drives
  them daily.
- **The genuinely new work is the linking loop**, not tag extraction.
- **The extractor is prior art to copy, not to compete with.** Its revert endpoint, its deterministic
  detectors and its person resolution are the shape the linking loop should follow. If it already
  records enough to revert a batch, that is most of the provenance design in §7 solved.

**Before building anything, read `src/lib/tag-fill/extractor.ts` end to end.** If its revert is
robust, the linking loop should reuse the same batch-and-revert mechanism rather than invent one.

## 7. The safety model

This is the part that decides whether the feature is responsible to ship. These are writes to
litigation records, and the failure mode is not a crash — it is a quietly wrong fact that later gets
cited in a filing.

**1. Writes are off by default and off in `local`.** The `local` profile is fail-closed by design.
Write tools declare `profiles: ['routed']` or sit behind an explicit `SS_HAYSTACK_WRITE=1`. A read-only
Haystack MCP is useful on its own and should ship first.

**2. Every write carries provenance — and the mechanism already exists.** The tag-fill pipeline
writes an `ActionLog` row per applied pair, typed `tag-fill`, carrying a JSON before/after snapshot,
and a revert endpoint rolls the batch back. **Adopt this wholesale rather than designing provenance
from scratch.** The requirement below is what that log must carry for agent writes.

**2b. Provenance content.** A tag written by an agent must be distinguishable from one a
human typed, forever. Minimum: actor (`agent` / `human`), model id, session id, timestamp, and the
tool call that produced it. Without this, nobody can later audit which links to trust, and the whole
graph becomes unciteable.

**3. Propose-then-apply, not apply — copy the protocol that already works.** The tag-fill pipeline
has solved this, and its contract should be adopted rather than reinvented:

- **`dryRun` defaults to true** and writes nothing.
- A suggestion carries `currentValue`, `proposedValue`, a coarse `confidence` (high / medium / low),
  and a `sourceExcerpt` — the evidence, not a score alone.
- For a person it carries a seed with a **non-mutating `existingMatch` preview**, so the reviewer
  sees "matches an existing person" rather than "pending create".
- **Apply is a separate call that passes back the exact accepted values, and never re-runs the
  model.** This is the property that matters most: what was reviewed is precisely what is written.
  A design where apply re-infers can write something the reviewer never saw.
- Every applied pair writes a log row with a before/after snapshot, and a revert endpoint rolls the
  batch back.

Fully autonomous application is a setting, not the default, and never for a first run on a folder.

**4. Never overwrite a human decision.** If a slot already holds a value whose provenance is human,
the agent's write is rejected and surfaced as a conflict. Agent-over-agent may overwrite with a
higher confidence; agent-over-human may not.

**5. The draft guard is inviolable.** `recordStatus` lives in `Document.tags` and the invariants in
`.claude/agents/draft-record-guard.md` apply unchanged: detection is conservative, absence of a file
stamp alone never marks a draft, and **an agent must never promote a draft to filed.** A new write
path is exactly where this regresses, so the guard agent should review the implementation.

**6. Confidence is mandatory and recorded.** Every proposed kind or link carries a confidence and the
evidence that produced it (a citation, not a vibe). Low-confidence proposals go to a review queue
rather than into the graph. A link the model is unsure about is worse than no link, because the
cascade selection in the editor will silently walk it.

**7. No deletes — which the write path does *not* give you for free.** An earlier draft of this
section asserted "no deletes, ever" as though `commitEntity` had no delete mode. It has no delete
*mode*, but it has three destruction paths, all of which look like ordinary writes (§8.5). The rule
therefore has to be enforced in the tool layer: **an agent patch containing `null`, an empty string,
or an unparseable date is rejected before it reaches `commitEntity`.** Corrections happen by writing
a new value with provenance, never by clearing one.

## 8. Constraints the code already imposes

Four traps, each verified in source. Getting any of them wrong reproduces a defect class this
codebase has already paid for.

**Use the modern filter pipeline, not `readByHaystack`.** The header of
`src/app/api/haystack/read-grid/route.ts` records that the legacy translator remained MCP-only and
could not handle path traversal (`case->judge->displayName`) or the LanceDB `caseRef → case_id` alias.
Wiring new tools to it would produce filters that silently under-match and report a clean result —
the same shape as the recall defects fixed in reports v8 and v9.

**Return plain JSON, not Hayson.** A ref encoded as `{"_kind":"ref","val":"@id"}` costs tokens for
nothing. `read-grid` already does that conversion; reuse it.

**The scope graph cannot be a passthrough.** Its own comment notes the payload is a few hundred KB
because the canvas wants the whole structure to compute cascade selection. That is tens of thousands
of tokens. Summary plus drill-down is the only workable shape for MCP, and it is the main place where
the model's needs differ from the UI's.

**The tag bag is open, so validation will not save you.** `splitPatch` routes any unknown key into the
tags JSON, XETO specs are unsealed, and validation runs with `ignoreRefs: true`. A typo'd slot name
will be accepted and stored. The tool layer must validate slot names against `TAG_SPEC_BY_KIND`
itself, because nothing below it will.

### 8.5 Write-path hazards — verified in `src/lib/haystack/commit.ts`

Every one of these is a normal-looking write that destroys or moves data. The tool layer must handle
each explicitly; none of them will announce itself.

| Hazard | Mechanism | Required guard |
|---|---|---|
| **Writing `null` to a tag deletes it** | on update, tags are merged and then every key whose merged value is null is removed | reject `null` in agent patches; a deliberate clear is a separate, human-approved operation |
| **An empty string nulls a real column** | `splitPatch` converts `''` to `null` for any column | reject `''`; treat "no value" as omitting the key |
| **An unparseable date silently becomes `null`** | date coercion falls through to null rather than erroring | validate dates in the tool and reject, never pass through |
| **`caseRef` in a patch moves the filing to another case, non-transitively and irreversibly** | it is translated into the `caseId` column. Nothing verifies the target case exists (a bad id surfaces as a raw foreign-key error), and **the move does not cascade**: attachments, events and record rows each carry their own `caseId` and keep the old one, so one commit can split an entity tree across two cases with no error. Blanking the field is a deliberate no-op, so a move can be made but never undone by clearing it | never accept `caseRef` from an agent patch, in any op |
| **Writing a ref tag silently orphans its column** | `NON_TAG_COLUMNS` lists *column* names (`judgeId`, `movantId`, `parentMotionId`, `amendsId`, `supersedesId`) while patches carry *tag* names (`judgeRef`, `movantRef`, `motionRef`, `amends`, `supersedes`). The tag falls through to the bag and, on read, is assigned over the column-synthesised value. The column goes stale and unreachable — and the column is what foreign-key integrity and every ORM join actually use | the tool layer must write the column alongside the tag for every ref key that has one, or the graph becomes true only in JSON |
| **The 22 per-filing-type kinds have no create-time validation** | `REQUIRED_ON_CREATE` has no entry for them, so a create skips required-field checks and nothing sets `attachmentKind`; it fails deep in Prisma as a foreign-key or null-constraint error | `ssEntityEnsure` must go through `ensure-filing.ts`, which supplies the attachment kind, and must never raw-create these kinds |

Two smaller notes. `kind: 'case'` validates that `path` stats as a real directory, so
`ssCaseEnsure` needs the folder to exist and be reachable from the server process — relevant
when the model is on a different machine from the corpus. And `filterToTagFields` is dead code with
no callers; do not build on it.

### 8.6 Required fields on create

`REQUIRED_ON_CREATE` is keyed by **kind**, not by model. The tool layer should mirror this so a
missing field is a clean tool error rather than a Prisma exception:

| kind | required on create |
|---|---|
| `case` | `name`, `path` |
| `motion` | `caseId`, `title` |
| `motionEvent` | `motionId`, `caseId`, `kind`, `occurredOn` |
| `motionAttachment` | `motionId`, `caseId`, `attachmentKind` |
| `person` | `displayName` |
| `personRole` | `personId`, `scopeKind`, `scopeId` |
| `hearing` | `scheduledFor` |
| `court` | `name` |
| `clerksRecord`, `reportersRecord` | `caseId` |
| the 22 per-filing-type kinds | **nothing — see the hazard table above** |

## 9. What the model must decide

### 9.1 The edge vocabulary — eleven slots, not two

An earlier draft treated this as a two-edge problem. It is eleven, in two groups:

| Group | Slots |
|---|---|
| **Structural, filing → filing** | `motionRef` (filed under), `respondingTo`, `replyingTo`, `resolves` (an order rules on a motion — deliberately distinct from `motionRef`), `orderRef` (an attachment is *about* an order; a reference, not parentage), `amends`, `supersedes` |
| **Person attribution** | `judgeRef`, `movantRef`, `respondentRef`, `authoredBy` |

Every edge lives in **two places at once**, and the connectivity module exists to reconcile them.
Some have Prisma foreign-key columns; others live only in the open tags JSON. **`respondingTo`,
`replyingTo`, `resolves` and `orderRef` have no column at all.** Tags win over columns on every read.

**Two shadow sentinels must be suppressed or every row looks connected.** A Motion whose `id` equals
its `filingId` is an auto-materialised mirror of a Filing, and a MotionAttachment whose `motionId`
equals its own `id` is an FK-satisfying shadow parent. Any tool that reports connectivity must drop
both, exactly as the existing connectivity module does.

### 9.2 The work queue must be built, not reused

`ssWorklist` is the most important op here, and **the obvious basis for it does not work.**

`/api/scope/unconnected` defines "connected" at the weakest possible threshold: a row is connected
when it has **any** ref at all, including a person ref. So a response that already carries a
`motionRef` but no `respondingTo` counts as connected and never appears — and that is precisely the
row the agent needs to see. The semantics are *all-refs-empty*, where the design needs
*defining-slot-empty*.

Two further problems with reusing it: it takes no case parameter and scans the whole database
unpaginated, and its missing-field logic only ever asks a motion for a parent and a person, so a root
motion sits in the queue forever wanting a parent it should not have.

**The queue that is actually wanted already exists, but only in the browser** — `buildWorkbenchRows`
in the pairing workbench component, which selects filings whose **defining** slot is empty. It is
trivially liftable: no React dependency, no props beyond the graph, and it returns plain data. It
needs `suggestForSlot`, `linkVerdicts`, `planLink` and `buildScopeGraph` on the server, and those are
pure functions over the scope-graph payload. The only browser coupling in the link rules sits below
the planning layer, in the commit functions.

**So a link *suggestion engine* already exists too.** `suggestForSlot` proposes a target and
`linkVerdicts` judges legality. The agent's job is not to invent suggestions from nothing — it is to
adjudicate the cases the deterministic suggester cannot, which is a far narrower and more checkable
task.

`primarySlotFor` **returns null for a motion**, so motions never enter the queue. That is correct and
must be preserved: a motion is the root every other kind points at, and its own `motionRef` means an
amendment parent, not a place in a chain.

Three UI semantics to preserve when lifting, because each encodes a safety property:

1. **Only suggested rows start checked.** Checking a blank row would turn "I don't know" into a write.
2. **A blank row says "No clear candidate — choose one"** rather than guessing.
3. **Apply sends one batch and promises one undo for the whole batch.**

### 9.3 Chronology is a weaker check than it looks

An earlier draft leaned on dates as a free mechanical guard — a response cannot answer a filing made
after it. **`Filing.filingDate` is null across the entire corpus.** The only date available is a
hand-entered `filedOn` tag, which is exactly the sparse, human-maintained data this project is trying
to stop depending on.

So chronology cannot be assumed as a rejection rule. Before relying on it, measure how many filings
carry a usable `filedOn`, and look for an ordering signal that does not depend on hand entry —
docket sequence, or a date parsed from the document text during ingestion. If no reliable ordering
exists, that is itself a finding, and deriving one may be a prerequisite for safe autonomous linking.

### 9.4 The decisions themselves

Worth stating plainly, because it is the actual product:

| Decision | What constrains it |
|---|---|
| Is this filing a motion, response, reply, notice, order, or record? | `primaryKindForFiling`; the document's own caption text |
| Which motion does this response answer? | `respondingTo` targets a Motion; docket order and date bound it — a response cannot answer a later filing |
| Which attachment does this reply answer? | `replyingTo` targets a MotionAttachment |
| Who is the movant / respondent, and in what role? | `Person` + `PersonRole`, currently 0 rows |
| Is this document a draft or filed? | `detectDraftStatus`, conservative by design — the agent may not override it upward |

Chronology *would* be the useful constraint — it makes many links decidable without reading the text
and makes a proposal mechanically checkable. §9.3 explains why it is not available yet. Establishing
a trustworthy filing order is therefore on the critical path for phase 4, not a nicety.

## 10. Phasing

**Phase 1 — read-only Haystack MCP.** `ssScopeGraph`, `ssWorklist`,
`ssFolderSurvey`, `ssIngestStatus`, `defs`. No writes. Immediately useful:
the model can tell you what is unconnected and what ingestion missed. Ships behind no new risk.

**Phase 2 — ingestion control.** `ssCaseEnsure`, `ssIngestStart`. Writes, but only
the kind the upload UI already performs, and idempotent by hash.

**Phase 3 — entity materialisation.** `ssEntityEnsure`. Wraps existing idempotent functions.

**Phase 4 — the judgment loop.** `ssCommit` with dry-run default, provenance, confidence, and
the conflict rules from §7. This is the phase that needs the review gate and the draft-guard audit.

**Phase 4.5 — the ETL skill.** `skills/soundsuite-etl/SKILL.md`, written against whatever ops exist
at that point. Worth drafting early against phase 1's read-only ops, because writing the procedure is
what exposes the ops that are missing or awkwardly shaped.

**Phase 5 — autonomy, if earned.** Batch application without per-item approval, enabled per case,
after phase 4 has run long enough to measure the model's accuracy against human corrections.

Phases 1–3 are mostly wrapping. Phase 4 is the real work.

## 11. Risks and open questions

- **A wrong link is worse than a missing one.** Cascade selection walks edges, so a bad
  `respondingTo` silently widens or narrows a scope the user believes is correct. This argues for
  high confidence thresholds and for making links visibly agent-authored in the editor.
- **768 of 864 documents were discovered and never ingested** (§3.3). This dwarfs every other
  finding here. Before any linking work is worth doing, that backlog has to be promoted and
  processed, and nobody knows yet whether it will succeed — a terminal `ERROR` with no retry is the
  likely outcome for some fraction of it. **Phase 1's survey should be run before this plan is
  costed**, because it may turn out the real project is ingestion throughput, not graph building.
- **Nested case folders resolve by first-match prefix**, so a case directory inside another case
  directory attaches to the wrong case silently. The survey op should detect and report this.
- **The OCR-not-ready path is an unbounded requeue loop** that pauses all claims for 30 s each cycle
  with no attempt counter. An agent that re-drives errors could turn a slow problem into a stuck one.
  `ssRequeueErrored` needs its own cap.
- **The corpus spans multiple cases in one tree.** Folder-to-case mapping is not always one-to-one,
  and the survey tool must not assume it is.
- **Provenance has no home yet.** It can live in the tags JSON alongside the value, but that needs a
  shape decided once, up front, because retrofitting provenance onto existing rows is impossible.
- **Rate and cost.** A 200-filing case at one model read per filing is a real spend. The worklist
  should support batching related filings into one decision where the evidence overlaps.
- **`MotionEvent`, `PersonRole` and `Hearing` are empty**, so any tool touching them ships untested
  against real data.

## 12. Success criteria

| Check | Target |
|---|---|
| Unconnected filings in a case, before and after an agent pass | a measured reduction, reported per case |
| Agent-proposed links later corrected by a human | tracked; this is the accuracy metric that gates phase 5 |
| Human-authored values overwritten by an agent | **zero**, enforced, not merely observed |
| Drafts promoted to filed | **zero**, enforced |
| A case folder taken from empty to fully connected | achievable in one session, resumable across sessions |
| `query_case_graph` on a processed case | returns real lineage instead of empty results |

## 13. Open decisions for the operator

**0. Whole-app migration is decided, not open** (§6.5). What remains open is sequencing and the
admin carve-out. The recommendation in this plan: entity CRUD first, derived reads second, jobs
third, read-only admin fourth, destructive admin never bridged.


**1. Is the 768-document backlog the real project?** 89% of the corpus was discovered and never
ingested (§3.3). Until that is promoted and processed, there is little graph to build and no way to
know how much of it will fail — the parsing worker has no retry. Phase 1's survey answers this
cheaply, and the answer may reorder everything below it.

**2. Does the job-handle convention get designed once, now?** *(Now load-bearing: §6.5 makes bucket
3 a whole-app concern, not a one-off.)* Haystack standardises no shape for
long-running work (§6.4). Promotion, parsing and re-drive all need one. Deciding it once costs an
afternoon; improvising it per op costs a rewrite later, and inconsistently shaped status is exactly
what makes an agent loop unreliable.

**3. The stale line in `CLAUDE.md`.** Line 103 documents the status transitions as beginning at
`QUEUED`. They begin at `DISCOVERED`, and nothing promotes automatically. That single wrong word
plausibly explains why 768 documents sat unnoticed. I have not edited it — a peer agent surfaced it,
not the operator, and project instruction files should not change on an agent's say-so.

### 13.4 Where to start, if only one thing gets built

Phase 1 is safe and useful on its own, and I would ship it before designing phase 4 in detail —
because the worklist output will tell us how much of this is a linking problem and how much is a
re-parsing problem. Those need different tools, and right now we are guessing which one dominates.
