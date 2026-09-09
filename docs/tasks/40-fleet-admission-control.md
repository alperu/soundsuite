# Fleet routing spreads load but never refuses it — no admission control, no queue

**Status:** Items 1–7 done · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-09
· **Worked:** 2026-09-09

**Report:** [`../MCP-Improvements/REPORT-v15-sidecar-model-awareness.md`](../MCP-Improvements/REPORT-v15-sidecar-model-awareness.md)
**Interacts with:** [task 38](./38-interactive-embedding-budget.md) (concurrency multiplies the budget gap) · [task 39](./39-role-aware-readiness.md)

Field names and code citations only. No case data.

> **Read "Verification results" (below) before the body of this task.** Four premises stated below
> were refuted — three by reading source, one by measurement. The body is left as originally written
> so the refutations can be checked against it.

## The question this answers

*"Five users call at once — which sidecar gets used, and is there a system for that?"*

**Yes, and it is better than expected.** Load spreading is real, measured and GPU-aware. What does
not exist is any notion of **too much**.

## What exists, and works

`resolveEndpoint(role, { excludeHosts })` in `src/lib/gpu/fleet-router.ts` runs **per request**, not
per session, in two phases:

**Phase 1 — choose among hosts already running the role**, by measured load (`:999`):

```ts
const load = cached.roles?.[role]?.activeRequests ?? cached.activeRequests ?? 0;
```

with **GPU residency as the tie-break, and a hard guard for GPU-only roles** (`:1003-1015`):

```ts
if (gpuPct >= 99) {
  // Fully GPU-loaded — prefer this, pick by lowest load
  if (load < bestLoad || (load === bestLoad && gpuPct > bestGpuPct)) { … }
} else if (gpuPct >= 0) {
  // CPU-offloaded — track as fallback only (and never accept for gpuOnly roles)
  if (!roleIsGpuOnly && load < cpuOffloadedLoad) { … }
```

**Phase 2 — if no host is running the role**, pick the first reachable sidecar and `POST /acquire`
to start one (`:1083+`), which also resets that role's idle timer.

Plus: `releaseEndpoint()` on completion, a `minOnline` floor of warm containers per role, and
per-`(sidecar, role)` acquire back-off — two free attempts, then 30 s → 60 s → 120 s → 300 s cap,
reset on success.

**So five concurrent users are spread across hosts by measured load, preferring whichever host has
the model resident on GPU.** That part needs no work.

## Defect 1 — the load counter can choose, but can never refuse (verified)

`activeRequests` occurs at exactly **three** places in `fleet-router.ts`:

| Line | Use |
|---|---|
| `:143` | the type declaration |
| `:999` | read, to pick the least-loaded host |
| `:1078` | written into a log field |

**It is never compared against a limit.** There is no per-host cap, no per-role cap, no rejection
path. If all five users arrive and every host is saturated, the fifth request still routes to the
least-bad host and waits. There is no *"busy, try later"*, and no queue — and the only backpressure
in the system is the caller's own timeout expiring.

`src/lib/gpu/command-queue.ts` is **not** an admission queue; it is a transport fallback for reaching
a sidecar without a WebSocket. (Confirm in item 1 before relying on this.)

## Defect 2 — read-then-acquire is a thundering herd (inferred, not observed)

The ordering is: **read cached load → choose host → then `/acquire`.**

`statusCache.getSidecarStatus()` is a snapshot refreshed on the sidecar's own cadence. So N
concurrent resolutions can all read the *same stale* `activeRequests`, all conclude the same host is
least loaded, and all route there — with the `acquire` arriving too late to arbitrate, because
selection already happened.

**This follows from the code path and has not been measured.** Item 2 exists to settle it before
anything is built against it — the standing rule in this repo, after four premises of v12 and three
of v14 were refuted by exactly this kind of check.

## Defect 3 — release is fire-and-forget, so the counter can leak (verified mechanism)

`fleet-router.ts:1147-1152`:

```ts
/** Release an endpoint after use. Fire-and-forget. */
export function releaseEndpoint(role: GpuRole, sidecarUrl: string): void {
  sendToSidecar(sidecarUrl, '/release', { role }).catch((err) => {
    logger.warn(`Failed to release ${role} on ${sidecarUrl}`, { error: (err as Error).message });
  });
}
```

A lost release — network blip, or the master dying mid-request — leaves that host's `activeRequests`
elevated **permanently**, with nothing to reconcile it. The router then biases *away* from a host
that is actually free.

The failure mode is quiet and cumulative: routing decisions degrade over time with no error anywhere,
and the only symptom is uneven load nobody can explain. **The mechanism is verified; the leak
occurring in practice is not.**

## Where this meets task 38

[Task 38](./38-interactive-embedding-budget.md) treats the interactive-budget gap as single-user
latency. **Concurrency multiplies it**, and this task is why:

- `resolveEndpoint` runs per request and **Phase 2 can start a container**, so a request arriving at
  a cold role pays the cold start *inside the caller's timeout*.
- With `EMBED_TIMEOUT_MS = 120_000`, three attempts, and each retry re-resolving with `excludeHosts`,
  five users hitting a cold fleet can each independently trigger acquires and each wait out their own
  cold start.
- Therefore **sidecar acquire time sits inside the interactive budget** — task 38 §2's ~370 s
  arithmetic is computed from Ollama constants alone and is a **lower bound**, not the total.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building.** Re-verify `:999`, `:1003-1015`, `:1078`, `:1147-1152`, and that `activeRequests` is still compared to no limit. Confirm `command-queue.ts` is a transport fallback, not an admission queue. | ☑ |
| 2 | **Measure the herd before fixing it.** Fire N simultaneous resolutions for a cold role and record how many select the same host. If they distribute acceptably in practice, the fix is smaller than the code path suggests — and if they do not, the measurement is the design input. | ☑ |
| 3 | **Reconcile the load counter.** A leaked `activeRequests` needs a floor: the sidecar already tracks `lastAcquire`/`lastRelease` per role (`sideCar/src/lib/state.ts:52-57`), so a stale-acquire sweep is cheaper than distributed bookkeeping. Prefer that to making release reliable. | ☑ |
| 4 | **Decide whether admission control is wanted at all**, and write the reasoning down. For a local single-operator system, queueing may be the wrong answer and a fast honest failure the right one. See the design note below. | ☑ |
| 5 | **If refusing: make the refusal legible.** A caller told "busy" must learn which role was saturated and roughly for how long. A bare 503 recreates the `notReady` defect — a signal that says nothing actionable. | ☑ |
| 6 | **Close the selection→acquire window** if item 2 shows it matters: optimistic increment on selection, or let `/acquire` return a rejection the router can retry elsewhere. Prefer the latter — the sidecar knows its own load better than a cache does. | ☑ |
| 7 | Cross-reference [task 38](./38-interactive-embedding-budget.md): add acquire time to its budget arithmetic and note the ×N concurrency factor. | ☑ |

## A design note before item 4

**Do not add a queue reflexively.** This series' recurring defect is systems that report more
confidence than they earned; a queue is the scheduling equivalent — it converts *"the fleet cannot
serve you"* into *"you are waiting"*, which reads as progress and is the harder failure to diagnose.

For five users on a local fleet, the honest options are probably:

1. **Cap and refuse fast**, naming the saturated role — the caller can retry, downgrade, or tell the
   operator. Composes with [task 39](./39-role-aware-readiness.md): a saturated role is a role that
   is *not ready right now*, which the readiness mechanism can already express.
2. **Cap and queue with a stated bound** — only if the wait is short and the caller is told the
   position and the bound.

Option 1 is smaller, and it is the one that makes `TOOL_NOT_READY` mean something instead of a silent
wait. Choose deliberately; do not inherit a queue because queues are conventional.

## Risks

- **Admission control can starve a legitimate burst.** A cap tuned for steady state will refuse a
  reasonable five-user spike. Tune against item 2's measurement, not intuition.
- **Fixing the counter leak changes routing.** Hosts currently biased against will start receiving
  traffic. That is the fix working; expect the distribution to shift.
- **Do not cap per-host without knowing per-host capacity.** A 24 GB host and an 8 GB host do not
  have the same ceiling, and `vram` is already in the role definition (`sideCar/src/lib/state.ts:19-51`).
- **This task must not silently change `gpuOnly` behaviour.** The guard at `:1003-1015` refusing
  CPU-offloaded hosts for GPU-only roles is correct and load-bearing; admission logic must sit
  alongside it, not replace the branch.

## Acceptance

| Check | Expected |
|---|---|
| N simultaneous resolutions, cold role | distribution recorded (item 2), before any change |
| A saturated fleet | caller gets a fast, specific answer naming the role — not an unbounded wait |
| A lost release | the counter self-heals within a stated bound; routing recovers |
| A GPU-only role | still never routed to a CPU-offloaded host |
| Task 38's budget arithmetic | includes acquire time and the concurrency factor |
| `activeRequests` | compared against something, or explicitly documented as advisory-only |

---

# Verification results (2026-09-09)

## Confirmed

- **`activeRequests` is compared against no limit.** It occurs at exactly three places in
  `fleet-router.ts` — `:143` (type), `:999` (read for selection), `:1078` (log field) — and none is a
  comparison. Confirmed by grep across `src/`.
- **The `gpuOnly` guard is real and load-bearing.** `fleet-router.ts:1003-1015` plus the refusal
  branch below it throw `NoGpuReadyEndpointError` rather than fall back to a CPU-offloaded host.
  Untouched by this work; two regression tests now pin it.
- **`command-queue.ts` is a transport fallback, not an admission queue.** Its module docstring says
  so, and `queueSidecarCommand` tries WS first, then a DB command queue for the sidecar to poll. It
  has no notion of load, capacity, or rejection. Item 1's flagged uncertainty is settled.
- **Per-role load really is available to the router.** `handleStatus` emits
  `roles[role].{activeRequests,lastAcquire,lastRelease}` (`sideCar/src/lib/handlers.ts:899-906`) and
  **both** heartbeat paths forward `roles` into the cache — WS at `src/lib/gpu/ws-relay.ts:232` and
  HTTP at `src/app/api/admin/gpu/sidecars/heartbeat/route.ts:56`. So `:999`'s
  `cached.roles?.[role]?.activeRequests` is genuinely per-role and only falls through to the summed
  legacy counter on old sidecars. The "load spreading is real and measured" premise **holds**.

## REFUTED

**R1 — "the leak occurring in practice is not [verified]" (Defect 3). It has occurred.**
`src/lib/search/reranker.ts:264-268` documents a fixed instance in this codebase: a failover path
sent one `/acquire` per failed candidate while `markRequestDone()` sent only one `/release` —
*"Net leak: +1 activeRequests per failed call, which kept idle timers from ever starting and pinned
VRAM at 99%."* The consequence is also **worse than this task claims**: not merely "uneven load
nobody can explain" but idle timers that never arm and VRAM pinned at 99%, which starves every other
role on that host.

**R2 — "with nothing to reconcile it" (Defect 3). Reconciliation exists; it is just manual.**
`sideCar/src/lib/handlers.ts:724` (`handleResetCounters`) zeroes a role's counter and re-arms the
idle timer; it is exposed at `sideCar/src/app/api/reset-counters/route.ts` and over WS
(`sideCar/src/lib/ws-client.ts:209`), and the master already fans it out at
`src/app/api/admin/gpu-reset/route.ts`. What is missing is **automatic** reconciliation, not any.
**Consequence for item 3: no sidecar change is needed.** The task's fallback ("report if the clean
fix requires sidecar edits") does not apply.

**R3 — Defect 2's stated mechanism does not apply to the cold path at all.**
Defect 2 is framed as *"read cached load → choose host → then /acquire"*, i.e. a stale-snapshot
problem. But **Phase 2 reads no load whatsoever**: it iterates `reachable` and returns on the first
`/acquire` that does not error. There is no `activeRequests`, no GPU pct, no tie-break — it takes
`reachable[0]`. For the cold role item 2 asks about, the herd is a **no-selection-criterion** defect,
not a staleness defect. Item 6's framing ("close the selection→acquire window") aims at the wrong
phase for the cold case.

**R4 — staleness is not the dominant cause of collision on a warm fleet either.** See below.

## Item 2 — measured distribution (the empirical result)

Harness: `src/lib/gpu/__tests__/fleet-router-herd.test.ts`. Three synthetic sidecars
(`host-a/b/c`), N = 5 concurrent `resolveEndpoint()` calls, faked status cache, mocked
`/acquire`. No real hardware, no network.

| Case | Fleet state | Distribution |
|---|---|---|
| **A** cold — no container running | frozen cache | **`host-a: 5`** (100% collision) |
| **B** warm — all running, load `[0,0,0]` | frozen cache | **`host-a: 5`** (100% collision) |
| **C** warm — all running, load `[4,1,7]` | frozen cache | **`host-b: 5`** (100% collision) |
| **D** warm, load `[0,0,0]`, `/acquire` fed back — **sequential** | reactive | **`host-a: 2, host-b: 2, host-c: 1`** |
| **B′** warm, load `[0,0,0]`, `/acquire` fed back — **concurrent (`Promise.all`)** | reactive | **`host-a: 2, host-b: 2, host-c: 1`** |

**The finding (R4): all three frozen cases collide 100%, but staleness only explains one of them.**

- **A** collides because Phase 2 has *no selection criterion*. A perfectly fresh cache changes
  nothing — there is no load read to be stale.
- **B** collides because Phase 1's tie-break is deterministic first-wins
  (`load < bestLoad || (load === bestLoad && gpuPct > bestGpuPct)`). With equal loads no candidate
  ever displaces `host-a`. **A perfectly fresh cache also changes nothing here** — and `[0,0,0]` is
  precisely the state an idle fleet is in when five users arrive, i.e. the scenario this task exists
  to answer.
- **C** is the only case where the doc's stated mechanism is the actual cause.

So the herd is real and total, but the doc named the wrong cause for the two most common burst
scenarios. Correspondingly, the frozen-cache 100% figures in A and B are **arithmetic, not
measurement** — the selection loop is synchronous over an in-memory Map, so concurrency cannot
interleave inside it. They are recorded as such rather than dressed up as an empirical discovery.

**Design input for item 6:** feedback from `/acquire` — the response the router currently discards —
spreads the burst across all three hosts. Case **D** is sequential, so it only establishes the upper
bound of what feedback can buy; case **B′** was added to settle the concurrent question honestly, and
**it matches D exactly**. `resolveEndpoint` awaits `getFleetStatus()` before its selection loop, so N
concurrent calls interleave at that await and the feedback lands. A real network makes that
interleaving *more* likely, not less, since a real `/acquire` round trip is far longer than a mocked
one.

So feedback fixes **B and C**, concurrent as well as staggered. It does **not** fix **A**: Phase 2
has no load criterion to feed. Item 6 was scoped to the feedback step only; see "Not built" below.

## What was built

| Item | Change |
|---|---|
| 3 | `effectiveRoleLoad()` in `fleet-router.ts` — routing-time **stale-acquire discount**. A positive `activeRequests` whose `lastAcquire` is older than `FLEET_STALE_ACQUIRE_MS` (default 15 min) routes as 0 and logs a WARN naming the reported value. Wired in at the `:999` load read. |
| 4 | Decision recorded below. **Cap-and-refuse, opt-in, off by default** — `readAdmissionCaps()`. |
| 5 | `FleetSaturatedError` in `src/lib/gpu/errors.ts`, carrying `role`, per-host `{hostname, load, cap}`, the cap, and an **advisory** `retryAfterMs`. |
| 6 | Phase 1 no longer discards the `/acquire` response: the sidecar-reported `activeRequests` is written back via a new narrow `statusCache.updateRoleLoad()`. |

Tests: `src/lib/gpu/__tests__/fleet-router-herd.test.ts` (6), `fleet-router-admission.test.ts` (25).

### The cap is a candidate FILTER, not a check on the winner

This is the subtlety per-host caps introduce. The selection loop picks the minimum **load** — not the
minimum load **relative to its own cap**. With caps `{host-a: 2, host-c: 12}` and loads `[5,5,5]`,
`host-a` wins on load and is over its cap, but `host-c` has seven free slots and the fleet is not
saturated. Checking the winner after the fact would refuse a request a healthy host could serve, and
the per-host map — added precisely to honour "do not cap per-host without per-host capacity" — would
be the thing causing wrong refusals. So the cap is applied inside the loop, skipping over-cap hosts
as candidates. Pinned by a test.

### Which refusal speaks, when both could

`FleetSaturatedError` is thrown **before** the `gpuOnly` branch, but only counts a host as saturated
if the role could otherwise have used it (`viableForRole`). Both halves matter:

- **Before the branch:** a gpuOnly role whose hosts are all GPU-ready but all at cap would otherwise
  be told "no GPU-ready sidecar" — false, and exactly the `notReady` defect in a new place.
- **`viableForRole`:** for a gpuOnly role, a *CPU-offloaded* host was never a candidate, so counting
  it as saturated would tell the operator that raising the cap would help. It would not. That case
  still throws `NoGpuReadyEndpointError`.

Both orderings are pinned by tests, alongside the two invariant tests that a GPU-only role is never
routed to a CPU-offloaded host — including with a cap so low the fleet is saturated as well.

### The feedback write must not touch `lastSeen`

`updateSidecarStatus` unconditionally stamps `lastSeen: Date.now()`. Routing item 6's write through
it would make liveness self-certifying by the router's own writes: `isSidecarConnected` treats
anything newer than `STALE_THRESHOLD_MS` as connected, and `sendToSidecar` serves a cached `/status`
younger than 15 s. A sidecar that had stopped heartbeating but still answered `/acquire` would read
as connected indefinitely — "UNREPORTED is not down", run in reverse. Hence the new narrow
`statusCache.updateRoleLoad(agentUrl, role, activeRequests)`, which writes only that role's entry.
A test asserts `updateSidecarStatus` is never called on the feedback path.

### Item 3 — why a discount, not an automatic `/reset-counters`

Per R2 the reset endpoint already exists, so auto-firing it was the obvious move. It was rejected:
zeroing the sidecar's counter on a heuristic can clobber a request that is **legitimately still in
flight** (a long OCR job), which lets the idle timer stop a container out from under it — turning a
routing-quality bug into a correctness bug. The discount mutates no sidecar state, so it cannot fight
an in-flight request; its worst case is routing to a busy host, which is what happens today anyway.
The manual `/api/admin/gpu-reset` remains the way to actually clear a leaked counter.

The threshold is deliberately generous (15 min, not the 120 s interactive timeout) so a
legitimately long job is never discounted, and the discount **never fires without the signal**: no
`lastAcquire`, or an unparseable one, means no discount. UNREPORTED is not stale.

> **This changes routing, by design.** Hosts currently biased against by a leaked counter will start
> receiving traffic again. Expect the distribution to shift. That is the fix working.

### Item 4 — the decision: cap and refuse, opt-in, off by default

**Decided: option 1 (cap and refuse fast, naming the role). Not a queue.**

- A queue converts *"the fleet cannot serve you"* into *"you are waiting"*. On a local
  single-operator fleet there is no second shift to drain the backlog — the wait just moves the
  failure somewhere harder to see. This series' recurring defect is components reporting more
  confidence than they earned; a queue is the scheduling form of it.
- Refusal composes with [task 39](./39-role-aware-readiness.md): a saturated role *is* a role that is
  not ready right now, which the readiness mechanism can already express.
- **It is off unless `FLEET_MAX_ACTIVE_PER_ROLE` is set.** Item 2 is the reason, not caution:
  a burst lands entirely on ONE host (case B), so a naive per-host cap of 4 would refuse the 5th of
  five users on a *completely idle* fleet. Until the spread in case D is the real behaviour, a cap on
  by default would manufacture exactly the burst-starvation this task's Risks section warns about.
  A regression test pins that five sequential requests on an idle fleet are never refused.
- **Per-host capacity** is stated by the operator via `FLEET_MAX_ACTIVE_PER_HOST`
  (JSON, hostname-keyed), not derived. `ContainerDef.vram` is a **memory footprint in MB, not a
  request ceiling**; converting one to the other would be an invented number, which is the failure
  mode this task series exists to remove. So the risk "do not cap per-host without knowing per-host
  capacity" is honoured by *not pretending to know it*.
- Refusal is evaluated on the **discounted** load (item 3), so a leaked counter cannot fake
  saturation. Tested.
- Admission sits **after** the `gpuOnly` refusal branch and never replaces it. Two tests assert a
  GPU-only role with only CPU-offloaded hosts throws `NoGpuReadyEndpointError` — including with the
  cap set to 1, i.e. when the fleet is saturated *as well*.

### Item 5 — legibility

`FleetSaturatedError` follows the existing `NoGpuReadyEndpointError` shape. `retryAfterMs` is
documented in the class as **advisory, not a promise**: nothing in the fleet predicts when an
in-flight request finishes, so the value is a polling hint sized to the heartbeat cadence, which
bounds how fast the router's view of load can change at all. Overclaiming here would recreate the
`notReady` defect in a new place.

## Not built, deliberately

- **A queue.** Item 4's decision, argued above.
- **Optimistic increment on selection (item 6's first option).** Cases D and B′ show the sidecar's
  own count, fed back, is sufficient for the warm cases — concurrent as well as sequential — and the
  sidecar knows its load better than a master-side guess. The precondition nobody had named was
  simply that Phase 1 *stops swallowing the `/acquire` response*; that is what was built.
- **A selection criterion for Phase 2 (the cold path, case A).** This is the one gap the measurement
  opened rather than closed. On a cold fleet every host has zero load, so adding a load read to
  Phase 2 would hit the same deterministic-tie problem as case B; spreading a cold burst needs a
  different tie-break (round-robin, or VRAM headroom) and a decision about whether five simultaneous
  cold starts on five hosts is better or worse than five queued behind one. That is a real design
  question, not a missing line of code. **Filed as follow-up, not built.**
- **Any `sideCar/**` change.** R2 established none is needed.

## References

- `src/lib/gpu/fleet-router.ts:143, 999, 1003-1015, 1078, 1083+, 1147-1152`
- `src/lib/gpu/fleet-router.ts:601,606,611` (shared-Ollama port rewrite), `:891-897` (cached container config preferred over `ROLE_PORTS`)
- `src/lib/gpu/command-queue.ts` — transport fallback, not admission
- `src/lib/gpu/status-cache.ts` — the snapshot selection reads from
- `sideCar/src/lib/state.ts:19-51` (`ContainerDef`, incl. `vram`), `:52-57` (`PerRoleState`: `activeRequests`, `lastAcquire`, `lastRelease`)
- `src/lib/ingestion/ollama-embedding-provider.ts:174-182, 272-274` — per-request acquire/release
