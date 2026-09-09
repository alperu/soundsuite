# MCP Report v16 — what five parallel tracks actually found

**Created:** 2026-09-09 · **Status:** execution record
**Scope:** tasks 21, 22, 24, 25, 26–32, 30, 34–37, 38, 39, 40
**Method:** five agents, disjoint file territories, each required to verify before building

Field names and code citations only. No case data.

---

## The headline

**Roughly one premise in five was wrong**, and the wrongness had a consistent shape.

| | Count |
|---|---|
| Premises checked across all tracks | ~90 |
| Refuted | 26 |
| Task items closed by verification rather than by work | 4 |
| New tests | 100+ |
| Regressions introduced | 0 (confirmed against a worktree at HEAD) |

The verification sweep alone checked 68 premises across eight task files and refuted 15. Its
conclusion, in the words of the agent that ran it:

> Every refutation in this sweep was about **where a defect lives or what to do about it, never about
> whether it exists** — no measured claim failed. These specs are reliable on symptoms and unreliable
> on mechanism, so the risk they carry is wasted build effort, not wrong priorities.

That is a more useful result than a raw error rate. The backlog's **priorities are trustworthy**; its
**diagnoses are not**. Reordering the queue would have been the wrong response — verifying each
mechanism before building against it was the right one.

Its secondary finding turns the lens on this report series itself:

> Corrections need the same verification as the claims they correct: tasks 29 and 31 both open by
> correcting v12, and **31's correction invented a documentation defect that does not exist.**

---

## The recurring defect, found five more times

The thesis carried since v12 — *the system describes what it intended to do more precisely than it
verifies what it did* — held in every track, at a new layer each time.

| Where | The silence |
|---|---|
| `query_case_knowledge` | Default `hybrid` degraded to keyword and returned **success**; a degraded empty result and a healthy empty result were both `{results: []}` |
| `research_evidence` | A failing sub-query is swallowed and returns a **successful, empty** result |
| `checkRoleAvailability` | A fully-stale fleet was reported `unavailable` — a host declared down on the strength of a stale snapshot |
| `fleet_status` (as specified) | Would have re-served cached container state: green while the path is sick |
| Ingestion sweeps | "The static surface is clean" was scoped to `src/lib/mcp` while the generation lives one directory over |

The last one is the sharpest. **A claim of absence made by a sweep carries the sweep's own
denominator**, and that denominator was never stated. The series' central discipline, missing from
the series' own methodology.

---

## Track 1 — degraded paths made visible (tasks 39 item 10, 22, 25)

**The refutation.** The `pushWarning` at the embed-degrade site reached nobody, for two
**independent** reasons — fixing either alone would have changed nothing, and either alone would have
looked like a complete fix:

1. Nothing ever supplied `pushWarning` on an MCP-facing context. It is optional on
   `ToolExecutionContext`; the production context is built with four fields and no warning sink, and
   `mcp-server.ts` passes no context at all.
2. No field could have carried it. `ToolExecutionResult` has no warnings member, `BaseMCPTool.execute`
   never reads them, and `mcp-server.ts` sends `result.data` alone.

**Denominator.** The channel is not dead everywhere — `deep-search.ts:509` supplies it for in-process
sub-query dispatch. But even there `gather-evidence` turns each warning into a progress event stored
on nothing. **No response object in the repo carried it.**

**Built.** A `retrieval` block (`searchModeRequested` / `searchModeEffective` / `vectorSearchApplied` /
`rerankApplied` / `rerankSkipReason` / `rerankPoolIn`) plus `warnings[]`, reusing `scan_for_pattern`'s
existing vocabulary rather than inventing a third. `RerankOutcome` threaded through the *existing*
options object so all three call sites keep their signature; all seven exits route through one
`skipped()` helper so an eighth cannot be added silently. Deleted
`const reranked = stats.rerankPool > 0`, which attached `rerankScore` to rows the cross-encoder never
saw.

**Also corrected:** task 22's own §3 table had an unreachable "thrown / fetch error" row — a refused
connection is absorbed per-host and exits via the all-hosts-failed path as `'degraded'`. The code was
right and the test wrong.

---

## Track 2 — fleet visibility (task 30)

**Two refusals, both the harder choice, both right.**

**The seven-state enum was not built.** Amendment (c)'s own warning says six of its seven states do
not exist upstream: `containers[role].status` is a bare string with observed literals
`running` / `not_found` / `error`, and host-runtime roles get a **synthetic `running`** the sidecar
assumes rather than probes. Inventing five values nothing produces would be the same
"green because nothing checked" defect in a new costume. Instead four orthogonal fields that never
collapse — `reported` (verbatim), `reportedSynthetic` + `syntheticBasis`, `stale`, `probe`. That
**labels** the synthetic `running` rather than laundering it.

**No fourth role→port map.** Unreported yields `port: null` and `probe: 'not_attempted'` with a
reason, rather than a fabricated default.

`fleet_status` probes rather than relays: a bounded `GET /v1/models` per vLLM role, selected by
*reported runtime* rather than a hardcoded `reranker`/`rlm` pair — more durable than the amendment
asked for. It makes **no network call at all** when no vLLM role is reported, asserted by test.

**Refuted:** `multiPass` is not absent from the research surface. `research-params.ts:23` already
lists it in `STEERING_KEYS`, so it is accepted-and-explicitly-ignored and named in `routing.ignored[]`.
The decision was "keep ignoring vs honour", not "add" — **keep ignoring**: it selects a synthesis path
and these tools never synthesise prose.

---

## Track 3 — parameter parity (task 30 Part 1)

**Landed as seven edits, not six.** `parseResearchParams` returns `Pick<GatherEvidenceOptions, …>`, so
without adding the two keys there, the change **compiles while the values stay invisible to every
consumer** — precisely the "accepted then silently dropped" failure Part 1 exists to prevent,
reintroduced by the fix for it. `tsc` caught it; a runtime test would not have.

**The spec's closing claim was refuted.** `searchMode: 'vector'` does **not** fail outright:
`query-case-knowledge.ts:333` throws, `base-tool.ts` converts to `{success:false}`, and
`deep-search.ts:511-516` **swallows it** — so `research_evidence` returns a successful, empty result.
The swallow is pre-existing and unconditional; threading `searchMode` widened its reach rather than
creating it.

**And the two mechanisms cannot meet.** `retrieval` / `warnings` live on a *returned* result; when the
tool throws there is no result object. Not a disagreement — an unreachable gap.

**Closed on `EvidenceResult` instead — and it turned out to be three holes, not one.** All three
previously silent exits in `executeParallelSearches` now report: the `!success` branch, a malformed
response (`MALFORMED_RESULT`), and the `catch`. The signal carries
`stats.subQueriesDispatched` (**the denominator**), `stats.subQueriesFailed`, and
`stats.subQueryFailures[]` with a per-sub-query code and message, plus `warnings[]` reusing the same
vocabulary as `scan_for_pattern` and `query_case_knowledge` — one contract across three tools.

The swallow was **not** narrowed: a test asserts healthy sub-queries still return evidence alongside a
failed one. The defect was **silence, not tolerance**. `EMBEDDING_UNAVAILABLE` is not special-cased —
a bare `EXECUTION_ERROR` and a thrown `ECONNRESET` report identically, so the visible failure set is
not quietly narrowed to the one that prompted the work.

A degraded empty result and an honest empty result are now distinguishable at the `research_evidence`
boundary; both were previously just `evidence: []`.

**A testing lesson worth generalising:** when a parser's output type is a `Pick` or any explicit
projection, widening the source interface is never sufficient. A runtime assertion passes either way,
because the value really *is* there — only the type says nobody downstream can see it.

Both `query_case_knowledge` call sites were threaded — the phase-1 dispatch and the independently
built RLM payload. A parameter honoured in phase 1 and dropped in the RLM rounds would have been this
repo's recurring defect in miniature.

---

## Track 4 — ingestion (tasks 34–37)

**Three refutations.**

- **Task 37 cited two files as prose generators; neither generates anything.** The real sites are
  `evidence-outline.ts` and `deep-search.ts`. And the claim that these are invisible to a sweep
  *"because a model writes them at runtime"* is half wrong: `evidence-outline.ts:197` emits a
  **literal** undenominated absence string, deterministic, no model involved.
- **Task 35 item 4 breaks its own acceptance criterion.** `ingestion-pipeline.ts:1039` stamps a
  hardcoded `parserVersion` — the only site in `src/` that writes it. Promotion cannot separate
  generations by `parserVersion`.
- **Task 34's failure table missed its most dangerous row.** `worker-init.ts:187-190` requeues
  `PROCESSING` with **no `filingId` predicate**, so a document that kills the process is requeued on
  every restart and, being oldest, is **claimed first** by `claimNextDocument`'s
  `orderBy: createdAt asc`. Self-sustaining, and the only one of the three loops that can take the
  process down rather than merely stall it. **Diagnosed, deliberately not fixed** — a wrong bound on a
  startup recovery path would strand legitimately-interrupted documents, and nothing currently records
  the difference between the two cases.

**Task 36 item 4 closed by verification:** that cohort is current-generation and needs no re-parse.

---

## Track 5 — admission control (task 40)

**Measured before building.** Task 40 marked the thundering herd *inferred, not observed*. N=5
concurrent resolutions against synthetic sidecars and a faked cache:

| Case | Result |
|---|---|
| cold, frozen cache | one host takes all five |
| warm, load `[0,0,0]`, frozen | one host takes all five |
| warm, load `[4,1,7]`, frozen | one host takes all five |
| warm, `/acquire` fed back, sequential | spread |
| warm, `/acquire` fed back, concurrent | spread |

**All three frozen cases collide — but staleness explains only the third.** The cold path collides
because phase 2 reads *no load at all* (it returns `reachable[0]`), so a fresh cache changes nothing.
The `[0,0,0]` case collides because the tie-break is deterministic first-wins — and that is exactly
the state an idle fleet is in when five users arrive. **Item 6's framing aimed at the wrong phase.**

The first two figures are reported as **arithmetic, not measurement**: the selection loop is
synchronous over an in-memory Map, so concurrency cannot interleave inside it. The concurrent variant
was added after review because the sequential case could not support a claim about concurrency — and
it **refuted a comment the agent had already written**.

**Refuted:** the counter leak is not hypothetical — `reranker.ts:264-268` documents a fixed instance,
and the consequence was worse than the task claims: idle timers that never armed and VRAM pinned,
starving other roles. And reconciliation **already exists**, only manually, so item 3 needed no
sidecar change at all.

**Built.** `effectiveRoleLoad()` applies a routing-time stale-acquire **discount** rather than
auto-firing the existing reset — zeroing on a heuristic can clobber a legitimately in-flight job and
let the idle timer stop a container under it, turning a routing bug into a correctness bug. A discount
mutates no sidecar state. No `lastAcquire` ⇒ no discount: **unreported is not stale.**

Admission control is **cap-and-refuse, opt-in, off by default** — driven by the measurement, not
caution: a burst lands entirely on one host, so a modest cap would refuse the fifth of five users on a
*completely idle* fleet. Per-host capacity is operator-declared, **not derived from `vram`** — that is
a footprint in MB, not a request ceiling, and converting one to the other would invent a number.

---

## Two near-misses of the same bug, three files apart

`getAllSidecarStatuses()` returns the raw cache with **no staleness filter**, unlike
`findSidecarsWithRole` and `isSidecarConnected`.

- `checkRoleAvailability` assumed the sibling's filtering applied and declared a silent fleet's role
  `unavailable`. **Fixed** (`4fa2f5bd`), with three regression tests.
- The admission track nearly hit it from the opposite direction: its feedback write would have gone
  through `updateSidecarStatus`, which stamps `lastSeen` — letting the router's own writes **certify a
  sidecar as alive**, defeating the very filter the first bug was about. A narrow `updateRoleLoad()`
  exists for that reason, with a test asserting `updateSidecarStatus` is never called on that path.

Same defect class, caught independently, in code written hours apart.

---

## Open decisions — these are the user's, not the agents'

1. **`worker-init.ts:187-190`** — the self-sustaining restart loop. Needs a way to distinguish a
   poison document from one interrupted by an unrelated crash. Nothing records that today.
2. **A durable attempt counter** — requires a schema change against the live database.
3. **Phase 2 cold-path selection** — the gap the measurement *opened*. On a cold fleet every host is
   at zero, so a load read just hits the deterministic-tie problem. Needs a different tie-break plus a
   decision on whether five simultaneous cold starts beat five queued behind one.
4. **Task 35's `parserVersion`** — bump the literal before wave one, or separate generations by
   timestamp and say so.

## Standing conventions this batch reinforced

1. **Verify before building.** ~1 premise in 5 was wrong, consistently about mechanism.
2. **A claim names its denominator** — including a claim made by a code sweep about its own scope.
3. **UNREPORTED is not down**, and *stale* is not *reported*.
4. **Do not invent states nothing produces.** Label the synthetic value; do not launder it.
5. **Measure before designing.** The herd measurement redirected the fix and closed one item while
   opening a better question.
6. **Corrections need the same verification as the claims they correct.**
