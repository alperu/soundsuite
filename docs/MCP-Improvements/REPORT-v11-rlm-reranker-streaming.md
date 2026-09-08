# MCP Report v11 — RLM, the reranker, and streaming

**Date:** 2026-09-08 · **Method:** live fleet inspection and one full `deep-rlm` job (139.9 s) against the running index
**Status:** findings open. No code changed. Includes three corrections to Report v10.
**Added 2026-09-08:** §6, search-page ↔ MCP parity (`/search` settings and `/admin/roleassign`).

All examples are synthetic, generic, or model-generated. No case names, cause numbers, party names,
filing titles, or document text.

---

## 1. Short answer: both are there, and both run

Yes to both — verified, not inferred.

**The fleet** (`GET /api/admin/gpu-fleet`, 5 sidecars connected):

| Host | Mode | Role | Model | Status |
|---|---|---|---|---|
| A | indexing | embedding | `qwen3-embedding:0.6b` | running |
| A | indexing | ocr | PaddleOCR-VL | **not_pulled** |
| A | indexing | code-embedding | jina-code-embeddings-1.5b | unloaded |
| B | searching | embedding | `qwen3-embedding:0.6b` | running |
| B | searching | completion | `qwen3.5:9b` | running |
| C | indexing | embedding / code-embedding / ocr / cuda | — | all running |
| **D** | searching | **reranker** | **`Qwen/Qwen3-Reranker-8B`** (vllm, :8099) | **running** |
| E | searching | *(none)* | — | **zero containers** |

**A `deep-rlm` job, run end to end:**

```
modelsUsed: { decompose: ollama/qwen3.5:9b,
              rerank:    Qwen/Qwen3-Reranker-8B,
              rlm:       mit-oasys/rlm-qwen3-8b-v0.1,
              outline:   ollama/qwen3.5:9b }
phases (ms): decompose 12,771 · retrieve 49,658 · pattern 1,093 · fuse 8,100
             · rlm 46,935 · outline 21,282        total 139,880
stats: retrievals 350 · chunksFused 224 · rerankPool 150 · evidenceTotalBeforeCap 161
```

So the RLM is not a stub: it consumed **47 seconds, a third of the job**, and emitted `rlmNotes`
describing its own recursive rounds. The outline produced a real object.

---

## 2. Three corrections to Report v10

I owe these before recommending anything.

**v10 §6 said `deep-report` returns `outline: null` because no instruct model is selected.** That is
stale. A completion container (`qwen3.5:9b`) is running, and the outline stage completed in 21.3 s
producing a populated object. The operator action I listed as outstanding — pull and select a small
instruct model — appears already done. `deep-report` specifically should be re-tested before the item
is closed, but the premise I gave for it is wrong.

**v10 §4 asked for a `get_chunk_context` tool. It has shipped** — `local` is now 25 tools, up from
24. But it is not yet reachable from the tools that need it; see §6c.

**v10 §5 said `speakers` is unpopulated.** Still true of the data, but `query_case_knowledge`'s own
schema advertises `speakers` as a returned field ("|-delimited transcript speakers") alongside
`blockType`, `headingPath` and `tableMarkdown`. The plumbing is built and waiting on the backfill —
which strengthens the case for running it, since nothing needs writing afterwards.

---

## 3. The reranker: provisioned, claimed, and unverifiable

The container runs and `modelsUsed.rerank` names it on every research call. But a caller cannot tell
whether it changed anything:

- **There is no `rerank` phase** in `stats.phases` — on either the `fast` or the `deep-rlm` run —
  while `decompose`, `retrieve`, `pattern`, `fuse`, `rlm` and `outline` are all itemised.
- **`rerankScore` is identical to `score` on every item returned**, and `source` reads `retrieval`.

Two readings fit. Rerank may be running *inside* the `fuse` phase — the arithmetic is suggestive:
150 candidates × ~60 ms ≈ 9 s against `fuse` 8,100 ms, and in the `fast` run 75 × 60 ms ≈ 4.5 s
against `fuse` 3,792 ms. Or the pool is assembled and never scored, and `rerankScore` is a copy.

**I am not going to guess which.** I have made that mistake on this project before — a correct
observation with an invented mechanism. The settling test is cheap:

> Run the same query twice in `fast` mode with `rerankPoolSize: 5` and `rerankPoolSize: 150`.
> If the top-5 ordering or scores differ, rerank is live and the issue is attribution only. If they
> are identical, the cross-encoder is not in the path.

**Either way, two things should change.** Add `rerank` to `stats.phases` so its cost is visible, and
keep the pre-rerank score in a separate field — `retrievalScore` alongside `rerankScore` — so the
caller can see *how much* the cross-encoder moved each item. Right now the most expensive component
in the search stack is the only one whose contribution cannot be measured. That matters
disproportionately for legal work, where "why is this the top passage" is a question that gets asked.

---

## 4. The RLM is real, unmanaged, and pointed at the wrong questions

### 4a. It is not in the fleet

No `ss-rlm` container exists on any of the five sidecars, yet the RLM ran. The source explains why:
`stream-rlm.ts` pins `RLM_PORT = 8100` and carries a comment about the sidecar reporting
`rlm.status='not_found'` while a service answers on :8100 anyway.

So the RLM is a hand-run process outside container management. Consequences: it does not appear in
`gpu-fleet`, has no health signal, no restart policy, and no VRAM accounting alongside the models
that *are* managed. Nothing warns you when it dies — `deep-rlm` would simply degrade.

**Fix:** register it as `ss-rlm` in the mode catalog (the mapping already exists) so it is
provisioned, health-checked and reported like every other role. If the model cannot be containerised
yet, then `gpu-fleet` should at least probe :8100 and report the role as external-but-present, rather
than staying silent about a component that consumes a third of every deep job.

### 4b. It amplified a bad decomposition

This is the more important finding. The decomposer turned a short legal query into six sub-queries,
of which **five were off-corpus** — it invented an employment-law frame (statutory termination
notice, WARN Act, contractual notice clauses) for a corpus that contains none of that. Retrieval then
spent **49.7 s** searching for them.

The RLM then ran its rounds on *the same wrong frames*, issuing further `query_case_knowledge` calls
against the invented topics and returning excerpts for each. It did exactly what it was asked to do,
recursively, in the wrong direction — and its 47 s of work inherited the error rather than catching it.

**This is the core answer to "how should the MCP utilise the RLM."** Today it is used as an
*amplifier* placed after decomposition. It should be used as a *corrector* placed around it:

1. **Ground decomposition in the corpus before spending retrieval on it.** Cheap version: run each
   candidate sub-query through a shallow retrieval and drop the ones returning nothing above a floor.
   Five of six sub-queries here would have been discarded in under a second, freeing the whole 49.7 s.
2. **Give the RLM the rejection signal.** Its value is recursive refinement — that is wasted if it
   never learns a branch was empty. Feed it "this sub-query returned nothing relevant" and let it
   re-plan, which is precisely what a recursive language model is for.
3. **Surface `rlmNotes` in the evidence result, not only in `research_status`.** It is currently
   `rlmNotes: []` on the final result while the running job exposed a populated array. The reasoning
   trace vanishes exactly when someone would want to audit it.
4. **Let the RLM see the reranker's scores.** It currently plans over topics; it should plan over
   *what retrieval actually returned and how well it scored*, so an empty or low-scoring round is
   visible to it as evidence.

Ordering matters more than any of the individual pieces: **cheap grounding first, expensive recursion
second.** Today it is the reverse.

---

## 5. Streaming: about 80% built, and the missing piece is small

You asked whether streaming is possible. It largely exists — it just stops short of MCP.

**What is already there.** `GET /api/mcp/research/{id}/events` returns
`application/x-ndjson; charset=utf-8`, one JSON object per line, **sequenced**:

```json
{"seq":0,"ts":…,"type":"progress","payload":{"phase":"routing","message":"mode deep-rlm (…)"}}
{"seq":1,"ts":…,"type":"progress","payload":{"phase":"decompose","message":"breaking question into sub-queries"}}
{"seq":2,"ts":…,"type":"progress","payload":{"phase":"retrieve","message":"searching 6 sub-queries","detail":{…}}}
{"seq":3,"ts":…,"type":"progress","payload":{"phase":"retrieve","message":"retrieved 6 sub-queries in 49658 ms"}}
```

And `research_status` already supports **incremental evidence pull**: it returns `cursor`,
`evidence`, `newEvidenceCount` and `rlmNotes`, so a caller can poll for only what is new (the job
reached `cursor: 161`).

**What is missing.** The MCP layer never exposes any of it. A `deep-rlm` call returns
`{ promoted: true, jobId, hint: "poll research_status…" }` and then the caller sits blind for 140
seconds, burning a tool call per poll.

**What to build.** MCP has a first-class answer: `notifications/progress`. When a caller passes
`_meta.progressToken`, the server may emit progress notifications against that token for the life of
the call.

1. **Bridge NDJSON → `notifications/progress`.** Each event already has `phase`, `message` and
   `detail`; map `seq` to the progress counter. This is a translation layer, not new machinery.
2. **Use `seq` for resumption.** Because events are sequenced, a dropped connection resumes from the
   last seen `seq` rather than replaying. Most streaming retrofits lack this; it is already here.
3. **Stream evidence, not just phase text.** `newEvidenceCount` plus `cursor` means partial evidence
   can be delivered as it lands, so a caller can start reading citations at 20 s instead of 140 s.
4. **Keep the job API as the fallback.** Not every client honours progress notifications; polling
   must keep working unchanged.

The bridge already reports `structuredContent: true`, so the transport supports it. The realistic
scope is the mapping layer plus a `progressToken` passthrough — the streaming source, the sequencing
and the incremental cursor are all done.

**One caveat worth stating.** Streaming makes a 140-second job *feel* fast; it does not make it fast.
Given §4b, most of that time was spent retrieving invented sub-queries. Grounding decomposition would
cut more wall-clock than streaming ever will. Do streaming for the interaction, not for the latency.

---

## 6. Search-page parity: what `/search` can do that MCP cannot

You asked for the report to cover making the search page's capabilities reachable through MCP. The
headline is better than expected: **most of the parity already exists.** The gaps are narrow, and one
of them is a whole category rather than a parameter.

### 6a. Parameter-level diff, measured against both surfaces

The search UI posts to `/api/search/ai` and `/api/search/deep`. Their accepted bodies, against the
MCP tool schemas:

| Search setting | MCP equivalent | Status |
|---|---|---|
| `caseId`, `whereClauses` | both tools | ✅ parity |
| `history` (conversational) | `research_evidence.history`, `query_case_knowledge.chatId` | ✅ parity |
| `limit` | `limit` / `maxEvidence` | ✅ parity |
| `searchMode` (`vector\|hybrid\|keyword`) | `query_case_knowledge.searchMode` | ⚠️ **missing on `research_evidence`** |
| `recordStatus` | `query_case_knowledge.recordStatus` | ⚠️ missing on `research_evidence` |
| `rlmMaxRounds` | `retrieval.rlmMaxRounds` | ✅ parity |
| `useRlm` (boolean) | `mode: "deep-rlm"` | ~ different axis; a boolean cannot be combined with another tier |
| `multiPass` | — | ❌ **absent** (`/api/search/deep` only) |
| `effort` (`low…max`) | `mode` tiers | ~ overlapping but not equivalent |
| `thinking`, `maxTokens` | — | ❌ absent |
| `provider`, `model` | refused on `local`; `preset_*` on `routed` | ✅ correct by design, not a gap |
| `workflowIds` (apply) | `search_workflows` finds them only | ❌ **cannot apply a workflow** |
| `softBoostRefs` | `query_case_knowledge.softBoostRefs` | ✅ parity |

So the concrete parameter work is small: **carry `searchMode` and `recordStatus` onto
`research_evidence`, add `multiPass`, and add a way to apply a workflow rather than only search for
one.** `provider`/`model` should stay refused on `local` — that boundary is the profile working as
designed, not a missing feature.

`effort`/`thinking`/`maxTokens` are generation knobs. On `local` the models are pinned, so they are
close to meaningless there; they belong on `routed`, expressed through presets, if at all.

### 6b. The real gap: fleet and role assignment have no MCP surface at all

`/admin/roleassign` is backed by `GET/POST /api/admin/role-assignments` (plus a `sync` route and
`pushModelRegistry`), which assign a role to a host and push the resulting model registry to that
sidecar. **No MCP tool touches any of it.** From MCP you cannot see which host serves which role,
cannot tell that a role is unassigned, and cannot move one.

That is why §3 and §4a of this report were hard to write: I had to read `/api/admin/gpu-fleet`
directly in the browser pane, because the MCP surface has no equivalent.

There is also a type-level blocker, and it explains §4a exactly:

```ts
export type GpuRole = 'embedding' | 'completion' | 'ocr' | 'reranker';   // fleet-router.ts:153
```

**There is no `rlm` role.** The RLM cannot be assigned to a host through `/admin/roleassign` because
the role type does not include it — which is precisely why it is hand-run on :8100, invisible to
`gpu-fleet`, and unmonitored. Adding `'rlm'` to `GpuRole` is the prerequisite for everything in §4a,
and it makes the port assignment you already do for other roles work for this one too.

**Suggested shape**, read before write:

1. `fleet_status()` — sidecars, roles, models, container status. Read-only, safe on `local`; this is
   the tool I wanted three times while writing this report.
2. `role_assignments_list()` — current role→host→port map, mirroring the GET route.
3. `role_assign({ host, role, model })` — the mutating one. This does **not** belong on `local`: it
   changes machine state, not search results. Put it on `routed`, or better, behind a distinct admin
   profile, and have it echo the resulting assignment for confirmation rather than returning bare
   success.

The read-only pair is the high-value half and carries almost no risk. The write half deserves the
same profile discipline the cloud-provider boundary already gets.

### 6c. `get_chunk_context` shipped, but the search tools cannot seed it

v10 §4 asked for context expansion and it now exists in `local`. Measured, it is not yet usable from
either search tool:

```
get_chunk_context({ chunkId: <from scan hit> })
  → INVALID_PARAMS: "chunkId is required"
```

because neither tool returns a chunk id:

| Tool | id fields returned |
|---|---|
| `scan_for_pattern` | `documentId` only — no chunk id |
| `query_case_knowledge` | `documentId` only — no chunk id |
| `research_evidence` | `id` **and** `documentId` ✅ |

So the new tool is reachable only from the most expensive path, while the two cheap paths that
actually need it — a scan hit that opens mid-turn, a semantic passage you want to widen — cannot call
it. **Fix: return the chunk id on `scan_for_pattern` and `query_case_knowledge` rows.** That is a
projection change, not new machinery, and it completes a feature that is otherwise already built.

One good sign while checking this: scan rows now carry `blockType` and `headingPath` fields, so the
structure projection is wired and genuinely waiting only on the backfill (§2).

## 7. Suggested order

| # | Item | Why | Cost |
|---|---|---|---|
| 1 | Settle whether rerank is in the path (§3 test) | one unknown blocks judging the whole stack | minutes |
| 2 | Add `rerank` to `stats.phases`; split `retrievalScore` / `rerankScore` | makes the priciest stage observable | small |
| 3 | Ground sub-queries with a shallow retrieval before deep retrieval (§4b.1) | would have saved ~50 s of ~140 s | small |
| 4 | Surface `rlmNotes` on the final result (§4b.3) | audit trail currently disappears on completion | trivial |
| 5 | NDJSON → `notifications/progress` with `seq` resumption (§5) | removes the 140-second blind wait | medium |
| 6 | Register the RLM as a managed role, or probe :8100 in `gpu-fleet` (§4a) | a third of every deep job is currently unmonitored | small |
| 7 | Feed rejection signals back into RLM planning (§4b.2, §4b.4) | turns an amplifier into a corrector | medium |
| 8 | Re-test `deep-report`; close or re-open the v10 outline item (§2) | my stated premise was wrong | minutes |
| 9 | Return chunk id on `scan_for_pattern` / `query_case_knowledge` (§6c) | completes a tool already shipped | trivial |
| 10 | `fleet_status` + `role_assignments_list` read-only MCP tools (§6b) | no visibility into the fleet from MCP today | small |
| 11 | Add `'rlm'` to `GpuRole` (§6b) | unblocks assigning the RLM a host and port like every other role | small |
| 12 | Carry `searchMode` / `recordStatus` / `multiPass` onto `research_evidence` (§6a) | closes the parameter gap | small |
| 13 | A way to *apply* a workflow, not only find one (§6a) | search page can, MCP cannot | medium |
| 14 | `role_assign` write tool on `routed`/admin profile only (§6b) | mutating; needs profile discipline | medium |

Items 1, 4, 6 and 8 are all under an hour combined and three of them are measurement rather than
code.

## 8. The theme, continued from v10

v10 found that recall bookkeeping had outrun the matching. This report finds the same shape one layer
up: **`modelsUsed` names four models, and for at least one of them the caller has no way to confirm
it did anything.** The RLM is real but unmanaged; the reranker is running but unattributed; the
decomposer is confident and, on this query, wrong in five of six branches.

The system is well instrumented at describing *what it intended to do*. The gap is evidence that it
did it. Streaming is worth building — but notice that streaming a phase list is more reporting, and
the same trap, unless the events carry what each stage actually changed.
