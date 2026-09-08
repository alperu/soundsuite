# MCP Report v13 — `corpus_status` shipped, and four v12 premises corrected

**Date:** 2026-09-08 · **Position:** implementer, working from v12's caller-side proposal
**Basis:** source read in this session, plus live calls against the running server and the live
database. Every number below was measured here, not carried forward.
**Status:** one tool built, tested and verified end to end. Eleven task files created. Everything else
is specified, not built.

No case data. Counts, field names, code citations and synthetic identifiers only. Cases appear as
A–E; the mapping is not recorded in this file.

---

## 1. What this report is

[v12](./REPORT-v12-mcp-surface-for-fast-correct-answers.md) was written from the caller's side,
without reading the source. It said so. This report is the other half: what the code actually does,
what was built, and which of v12's claims did not survive contact with it.

**Four of v12's premises were wrong.** That is the load-bearing fact here, and it changed the plan
rather than being noted and set aside. The specs derived from an unverified model of the system carry
the same risk, so they are marked as such rather than presented as settled.

| | |
|---|---|
| **Built, tested, verified** | `corpus_status()` — [task 23](../tasks/23-corpus-status-and-denominators.md) items 1–4, 7 |
| **Written against source read this session** | tasks [22](../tasks/22-rerank-observability.md), [24](../tasks/24-completeness-object.md), [25](../tasks/25-rlm-notes-live-trace.md) |
| **Diagnosed, not verified** | tasks [26](../tasks/26-batched-chunk-context.md)–[32](../tasks/32-draft-semantics-reconciliation.md), each marked in its own header |
| **Not touched** | [task 21](../tasks/21-chunk-overlap-defect.md) (chunk overlap) — unchanged, still the correctness floor |

---

## 2. The measurement v12 could not make

v12 §2a's central finding was that nobody could state what fraction of the corpus is searchable, *and
that this could not be established from the MCP surface*. It declined to assert the 768/864 figure as
measured, because it came from a plan document.

**It has now been measured, and the estimate was exact.**

| Measure | Value |
|---|---|
| Documents | **864** across 5 cases |
| `INDEXED` | **96** |
| `DISCOVERED` (never ingested) | **768** |
| Corpus coverage | **11.1%** |
| Chunks | **35,890** |
| Last completed ingest run | 2026-08-29 |

The chunk total independently reproduces the 35,890 figure v12 and
[task 20](../tasks/20-measure-chunk-overlap.md) worked from, from a different code path.

### Two things the corpus-wide number hides

**The status value is `DISCOVERED`, which is not one of the four conventional values.** The only two
values present are `DISCOVERED` and `INDEXED`. Neither `QUEUED`, `PROCESSING` nor `ERROR` appears.
`Document.status` is a bare `String` with no enum — `grep -rn "DocumentStatus" src` returns nothing —
and the four names come from a UI type at `src/app/api/progress/route.ts:26-32`.

A tool built against that list would have bucketed **all 768 un-ingested documents as nothing at
all**, silently, because they match no bucket. The design decision to group by observed values was
made before this was known and turned out to be the difference between a correct tool and a tool that
under-reports the problem by 89% of the corpus.

**Per-case coverage ranges from 44.4% to 2.3%:**

| Case | Indexed | Total | Coverage | Chunks |
|---|---|---|---|---|
| A | 15 | 54 | 27.8% | 9,571 |
| B | 6 | 258 | **2.3%** | **380** |
| C | 32 | 434 | 7.4% | 3,578 |
| D | 24 | 54 | 44.4% | 10,719 |
| E | 19 | 64 | 29.7% | 11,642 |

A corpus-wide 11.1% would let an operator working case B believe they had roughly five times the
coverage they have. **So the denominator in a proven-absence sentence must be the scoped case's, not
the corpus's** — a scan filtered to one case that quoted the corpus figure would be exactly the
technically-true-but-misread failure this series keeps finding.

Case B is worse than its document ratio suggests: it is the **largest case by document count** and
contributes **1.1% of the corpus text** (380 of 35,890 chunks). A scan scoped to it is searching the
smallest text surface in the corpus. That only became visible because chunks are counted per case.

---

## 3. What was built

`corpus_status()` — `src/lib/mcp/tools/corpus-status.ts`, registered in
`src/lib/mcp/tools/index.ts`, tested in `src/lib/mcp/tools/__tests__/corpus-status.test.ts`.

### How it works

One call, no LLM, read-only. Returns:

- `documents` — total, indexed, `byStatus` (observed values only), and `missingPageCount`
- `corpusCoverage` — indexed / total, 3 dp
- `cases[]` — per case: totals, `coverage`, `byStatus`, and `chunks` under `includeChunks`
- `chunks` — corpus total, or `null` with `unavailableReason`
- `ingest` — `lastJobCompletedAt` **and** `lastDocumentUpdatedAt`, separately
- `corpusStatusVersion` — so callers can branch without guessing

### Four decisions that are load-bearing rather than incidental

**1. `category: 'search'`.** `tool-registry.ts:156-157` sets `toolNeedsLlm = category !== 'search'`,
and under the `local` profile a non-`search` tool requires reachable Ollama (`:177`). A status tool
that fails closed on a degraded fleet is useless in exactly the situation you most want it. Asserted
by test.

**2. Status buckets come from `groupBy`, never an assumed list.** See §2. Asserted by a test that
specifically checks `DISCOVERED` survives.

**3. Two ingest timestamps, separately named.** `max(Document.updatedAt)` over-reports — it is bumped
by readiness backfill, case reassignment and the config-driven requeue at
`src/app/api/config/route.ts:234`. The honest "last ingest run" is `JobLog.completedAt`.

**They diverge by 9 days in production** — `lastJobCompletedAt` 2026-08-29 against
`lastDocumentUpdatedAt` 2026-09-07. A single merged "last ingest" field would have reported the
later, wrong one. This is the same over-claim the tool exists to stop, in miniature.

**4. An unreadable vector store yields `null` with a reason, never `0`.** A zero denominator is worse
than an absent one, because a caller will divide by it and print something confident.

### A defect the test found

The first test run returned `chunks.total: 0` rather than `null`, because LanceDB **is** importable
under jest and returned a zero count — my assumption that it would be absent was wrong. The tool was
therefore willing to serve a bare `0`, which is the exact "confident zero denominator" failure written
into task 23's own risk list.

The fix is a consistency guard, not a test adjustment: **a chunk count of zero alongside indexed
documents is a contradiction between two stores, not a measurement.** It now returns `null` with a
reason naming both quantities. The degraded-path tests were also made deterministic — they force an
unreadable `LANCEDB_PATH` rather than relying on the environment.

### Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean for the new and changed files |
| `npx jest src/lib/mcp/tools/__tests__/` | **16 suites, 458 tests, all pass** |
| `corpus_status()` live, cold | HTTP 200, 860 ms |
| `includeChunks: true` | 200, 455 ms; per-case chunks sum to **exactly 35,890**, delta 0 |
| `caseId` scoped | 200, **14 ms**; 1 case returned; corpus total still 864 |
| `routed` profile | 200 |
| Listed in `local` profile | yes — tool count **25 → 26** |

The per-case sum matching the independent `countRows()` total exactly is an internal-consistency
proof, not merely a passing call.

---

## 3a. Items 5–6 — the denominator is now carried, not merely available

`corpus_status()` made the denominator measurable. Task 23 items 5 and 6 make every proven-absence
claim carry it. Both are now done.

**New module: `src/lib/mcp/corpus-denominator.ts`** — one source, deliberately, because the report's
requirement is that the prose and (later) task 24's structured field agree. Two independent
derivations would drift and a caller comparing them would trust the wrong one. It resolves
documents-indexed / documents-total and indexed chunks **for exactly the cases a scan covered**, and
caches for 60 s with an explicit `asOf` — a scan pages, and re-reading per page is waste.

### The wording rule, as shipped

> **The word "proven" never appears without its subject.**

`"the absence is proven, not merely unreached"` is gone from the codebase. `grep -rn "absence is
proven" src/` now returns only the comment that explains the ban and the test that enforces it.

A coverage threshold was considered and **rejected in principle**. An absence is proven of the corpus
only at complete coverage; at 99% it is as unproven as at 11%, only less obviously. A threshold
creates a cliff where the wording turns confident while the claim is still false, and teaches
operators that "proven" means "coverage cleared the line". The clause needs no threshold — it has the
same shape at 2.3% and at 100%, and only the numbers move. At `documentsIndexed === documentsTotal`
it reads as a corpus-wide proof on its own, with no rule firing.

### Measured live, on the running server

The same pattern, at three scopes — this is the whole point of scoping the denominator:

| Scope | Emitted clause |
|---|---|
| Corpus | *"…exhaustive over the index: proven absent from the **35,890** indexed chunks of the corpus, spanning **96 of 864** documents (11.1% indexed)."* |
| Sparsest case | *"…proven absent from the **380** indexed chunks of this case, spanning **6 of 258** documents (2.3% indexed)."* |
| Densest case | *"…proven absent from the **10,719** indexed chunks of this case, spanning **24 of 54** documents (44.4% indexed)."* |

An operator scoped to the sparsest case previously read the identical sentence they would have read
at 44.4% coverage. They now cannot.

### Also changed

- **`scan_for_pattern`'s tool description** promised the retired phrase *"and `warnings[]` says so in
  those words"*. It now says the answer is proven **over the index**, that the warning names its
  denominator, and that coverage is partial and varies per case — pointing at `corpus_status`.
- **The escalation warning** now reads "exhaustive **over the index**" for the same reason.
- **`skills/soundsuite-mcp/SKILL.md` §"Proving a phrase is absent"** quoted the old sentence as the
  thing to look for. It now documents the new shape, the measured coverage range, and that the clause
  is scoped to what you searched.

### Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx jest src/lib/mcp/` | **33 suites, 752 tests, all pass** |
| The three prose-asserting suites | **passed unchanged** — they match `/exhaustive\|complete\|proven/i` plus a `BOUNDED` negative, and the new wording satisfies both |
| New `corpus-denominator.test.ts` | 28 tests, incl. the banned form asserted absent across **all seven** clause shapes |
| Live scan, three scopes | denominators correct and distinct per scope (table above) |
| Scoped scan wall clock | 37 ms (cached denominator), vs 1,133 ms cold |

**One test failed first and the assertion was wrong, not the code.** It asserted the chunks-unknown
shape omitted the phrase "indexed chunks of"; the correct requirement is that no chunk *number* is
invented. Fixed the assertion.

### What is still not built

Nothing yet emits a **machine-readable** denominator. A caller who wants to branch on coverage must
still call `corpus_status` separately, or parse the sentence. That is
[task 24](../tasks/24-completeness-object.md), which must consume `corpus-denominator.ts` rather than
re-derive — the module was built with that consumer in mind.

---

## 4. The four corrections

Each of these changed a task's shape, not just its wording.

### 4a. `rlmNotes` is inverted (v12 §4d)

v12: *"populated on `research_status` while a job runs and comes back empty on `research_result`."*

Both halves are backwards. `research_result` **carries** the notes — `research-jobs-tools.ts:91-95`
returns the `EvidenceResult` verbatim, including `rlm.notes` (landed at `gather-evidence.ts:466`,
typed `research-types.ts:138`). `research_status.rlmNotes` is `[]` **for the entire run**, because
`job.rlmNote()` is only called after `gatherEvidence` resolves — `start-research-job.ts:57` replays
them in a loop microseconds before the job flips to `done`.

So v12's prescribed fix — "carry it onto the final result" — is a **no-op**. It is already there.

Two further defects it could not have seen: **report jobs never call `rlmNote` at all**
(`start-report-job.ts:71-92` wires seven callbacks, not that one), and **the note text already
streams live as a per-item field** — `gather-evidence.ts:458-462` stamps `rlmNote` onto each evidence
item and fires `onEvidence` immediately. The broken `rlmNotes` array is the redundant surface.

### 4b. `notifications/progress` already exists (v12 §3b)

v12: *"None of it reaches MCP."* It does — in `scripts/mcp-bridge/bridge.mjs`, which reads
`progressToken` at `:224`, starts the relay at `:214-227`, and maps NDJSON to MCP at `:165-186`,
already keyed on `progress: evt.seq`. Every event carries `seq` (`research-jobs.ts:88`).

The task is not "build a translation layer" but "close the gaps in the one that exists": `evidence`
and `token` are deliberately unrelayed, `cursor` is on `research_status` but never on an event, and
`setOutline` / `setCost` / `rlmNote` mutate the record without calling `emit` at all.

### 4c. The 60 KB ceiling is client-side (v12 §3c)

Nothing in this repo enforces it. `mcp-server.ts:242, 248` serialises and returns. The figure lives in
documentation and in a client-side *display* summariser
(`public/mcp-client/soundsuite-client.js:25, 71`). A `fields` parameter would not lift a server limit.

The item survives on v12's *second* argument — pagination costs a call per page — and the first fix is
correcting `SKILL.md:522` and `public/mcp-client/README.md:57`, which present a client limit as a
server property.

### 4d. `rerankPoolSize` never reaches a response (v12 §6 item 2)

v12 frames the open question as "`rerankPoolSize` 5 vs 150". That parameter is **only ever read**,
never written into any response. The canonical default is 150 everywhere, and
`query-case-knowledge.ts:466` clamps it to `Math.min(150, Math.max(limit * 8, 40))` — which **floors
at 40** and can never yield 5.

The observed `5` was almost certainly `stats.rerankPool` (`gather-evidence.ts:581`), meaning **the
cross-encoder saw 5 candidates, not 150**. That is a recall/dedup problem upstream of rerank wearing a
rerank problem's clothes, and it is now [task 22](../tasks/22-rerank-observability.md) item 7.

---

## 5. The reranker, settled

v12 §4c could not confirm the reranker did anything and correctly declined to assert a cause. The
answer is that it **does** run, and the surface is structurally incapable of showing what it did.

**Configuration is live and the host is up** (measured this session): `rerank.enabled=true`,
`provider=vllm`, `host=http://10.10.20.5:8099`, `model=Qwen/Qwen3-Reranker-8B`, `poolSize=150`,
`topN=20`. The host answered `/v1/models` with **HTTP 200 in 0.37 s**.

Four defects compose into the blind spot:

1. **`rerankScore` and `score` are the same value by construction.** `reranker.ts:587-591` overwrites
   `score` in place with `relevance_score`, discarding the first-stage score; `gather-evidence.ts:424-425`
   then passes `s.score` as both fields. They cannot differ.
2. **Neither is the cross-encoder's score.** `deduplicateAndMerge` multiplies `score` post-rerank —
   transcript-intent ×1.35, table ×1.2, figure ×0.85, structure hints ×2.0 / ×1.5
   (`deep-search.ts:836-859`). Both fields carry *relevance_score × boosts*.
3. **The flag gating emission is a pool size read before the call.** `rerankPool = merged.length` is
   assigned at `deep-search.ts:796`, the rerank await is at `:798`, and it is never reassigned. All
   six degraded paths in `reranker.ts` return the input array unchanged, so a silent fallback to
   first-stage order is indistinguishable from success.
4. **RLM-round evidence is never reranked.** v12 flagged this as the first thing to check and declined
   to assert it. Confirmed from two sites: `deep-search.ts:798` is the only `rerank(` call in the file
   and `runRlmEvidenceRounds` (`:1628`) is defined inside it; `gather-evidence.ts:459-461` maps
   RLM-round items with the `rerankScore` argument omitted.

`stats.phases` is `routing, decompose, retrieve, pattern, fuse, rlm, outline`
(`gather-evidence.ts:220-226`) — no `rerank` key, and the await sits inside the `fuse` span
(`:378-380`). v12's timing inference was consistent with the code.

**Consequence for the fix:** v12 §4c proposes `retrievalScore` beside `rerankScore`. Three values are
needed, not two — first-stage, raw cross-encoder, and post-boost — plus a `rerankApplied` derived from
the actual outcome. And none of it is possible until the first-stage score stops being destroyed at
`reranker.ts:587`, which is why that is task 22 item 1.

---

## 6. `completeness` — smaller for one tool, larger for the other

v12 §6 sizes this as a single **S**. The two tools are not symmetric.

`scan_for_pattern` already returns `strategy`, `candidatePool`, `scanned`, `truncated`, `nextCursor`
and `warnings` (`scan-for-pattern.ts:1344-1352`), and computes every remaining fact internally. What
is missing is the exhaustive boolean, the denominators and `caveats`.

`query_case_knowledge` computes **none** of it — its entire assembly is `return { results:
enrichedResults };` (`:708`). Giving it a completeness object means deriving facts that do not exist.

There is also a blocker v12 could not see: **five of the needed variables are block-scoped and not
live at the return** — `poolCapped` (`:1075`), `fetchLimit` (`:1041`), `pageFills` (`:1095`),
`willEscalate` (`:1098`), `provenAbsence` (`:1101`). They must be hoisted first, which makes this not
a purely additive change.

### The wording rule

The decision taken this session, recorded in task 23 item 6 and task 24:

> **The word "proven" never appears without its subject.** `"the absence is proven"` is banned
> outright. The sentence always names what the absence was proven *from* — *"proven absent from the
> 35,890 indexed chunks, spanning 96 of 864 documents."*

A coverage threshold was considered and **rejected in principle**, not on the difficulty of choosing a
number. An absence is proven of the corpus only at complete coverage; at 99% it is as unproven as at
11%, only less obviously. A threshold creates a cliff where the wording flips back to confident while
the claim is still false, and teaches operators that "proven" means "coverage cleared the line". That
is the same bug, better hidden.

The wording rule needs no threshold: the sentence has the same shape at 11% and at 100%, and only the
numbers move. When `documentsSearched === documentsTotal` it reads as a corpus-wide proof on its own.

Correspondingly, `exhaustive` is renamed **`exhaustiveOverIndex`** and stays `true` when the search
really did read every indexed chunk — it is a property of the *search*, and a caller genuinely needs
to distinguish "I scanned everything available" from "I gave up at a cap". `corpusCoverage` carries
the other fact. **Two claims, two fields** — the same discipline as splitting `retrievalScore` from
`rerankScore`, and as `speakerBasis` in [task 28](../tasks/28-server-side-speaker-attribution.md).

---

## 7. Said plainly

**At 11.1% coverage, wording is damage control, not a fix.** No sentence rescues a corpus that is 89%
unsearchable. `corpus_status()` stops the tool overclaiming and makes the gap legible for the first
time; it does not make any answer more complete.

The ingestion backlog is the thing standing between this system and a negative finding that could be
put in a filing. Neither this report nor any task in it shortens that backlog. Task 23's own risk list
says the first output would look alarming and that this is the tool working — that has now happened,
and the number is 768.

**The v12 pattern held, including for v12.** Every defect this series has found has the same shape:
*the system describes what it intended to do more precisely than it verifies what it did.* v12 named
that pattern in §7 and then instantiated it four times — a report written from observed behaviour,
describing causes it had not checked. Two of its items (§4d, §3b) prescribed work that was already
done or was a no-op.

This is not a criticism of writing v12 from the caller's side; that vantage found real defects no
source reading would have surfaced. It is the argument for the split in §1: **build the smallest
checkable thing, and mark everything else as unverified until it is.** Eleven more specs written to a
high standard, none of them executed, would have made the ratio worse.

---

## 8. Where this leaves the ordered list

v12 §6, re-ordered against what is now known.

| v12 # | Item | Status now |
|---|---|---|
| 1 | `corpus_status()` + denominators | **Done and verified — tool, denominator wiring and wording rule** (task 23 items 1–7). Every proven-absence claim now names its scoped denominator |
| 2 | Confirm rerank is in the path | **Done.** It runs; the surface cannot show it. v12's framing corrected — see §4d, §5 |
| 3 | `completeness` object | Specified ([24](../tasks/24-completeness-object.md)); resized S→S+M; needs a variable hoist first |
| 4 | Carry `rlmNotes` onto `research_result` | **Void as written** — already there. Real defect is the live path ([25](../tasks/25-rlm-notes-live-trace.md)) |
| 5 | Batched `get_chunk_context` | Specified ([26](../tasks/26-batched-chunk-context.md)); needs an extraction refactor first; probes are 4–6 per call, not 3 |
| 6 | Ground sub-queries | Specified ([27](../tasks/27-subquery-grounding-gate.md)); cheaper gate found at `gather-evidence.ts:427` |
| 7 | `rerank` phase + `retrievalScore` | Specified ([22](../tasks/22-rerank-observability.md)); needs three score fields, not two |
| 8 | Server-side `speaker` | Specified ([28](../tasks/28-server-side-speaker-attribution.md)) |
| 9 | NDJSON → `notifications/progress` | **Largely exists** ([29](../tasks/29-progress-notifications.md)) — gaps only |
| 10 | Fleet read-only tools | Specified ([30](../tasks/30-mcp-parity-and-fleet-visibility.md)); `multiPass` framing corrected |
| 11 | Chunk overlap | Unchanged — [task 21](../tasks/21-chunk-overlap-defect.md), still the correctness floor |
| — | `fields` / pagination | Specified ([31](../tasks/31-result-size-economy.md)); reason corrected |
| — | "draft" ambiguity | Specified ([32](../tasks/32-draft-semantics-reconciliation.md)) |

**Recommended next**, on evidence rather than preference:

1. **Task 24** — the machine-readable `completeness` object, consuming `corpus-denominator.ts`. The
   prose is now honest; callers still have to read English to learn it. Five variables need hoisting
   first (§6).
2. **Task 22 item 1** — preserve the first-stage score. One line, and every other rerank
   question is unanswerable without it.
3. **Task 22 item 7** — reproduce the 5-candidate pool. If the cross-encoder is routinely handed 5
   candidates where 150 was configured, that is a live recall defect and outranks the rest of task 22.
4. **The ingestion backlog** — 768 documents, per §7. Everything above improves how honestly the
   system reports its limits; only this changes them.

---

## 9. Files

**Added**
- `src/lib/mcp/tools/corpus-status.ts`
- `src/lib/mcp/tools/__tests__/corpus-status.test.ts` (11 tests)
- `src/lib/mcp/corpus-denominator.ts`
- `src/lib/mcp/__tests__/corpus-denominator.test.ts` (28 tests)
- `docs/tasks/22-rerank-observability.md` … `docs/tasks/32-draft-semantics-reconciliation.md` (11 files)

**Changed**
- `src/lib/mcp/tools/index.ts` — import, instantiation, re-export
- `src/lib/mcp/tools/scan-for-pattern.ts` — both proven-absence warnings now carry a scoped
  denominator; the tool description and the escalation warning say "over the index"
- `skills/soundsuite-mcp/SKILL.md` — the proving-absence section documents the new wording and points
  at `corpus_status`
- `docs/tasks/README.md`, `docs/tasks/23-*.md` — index rows, provenance note, items 5–6 marked done

**Response shapes** — unchanged. `scan_for_pattern` returns the same fields; only the text inside
`warnings[]` differs, and it differs in the direction of saying less than it used to, not more.
