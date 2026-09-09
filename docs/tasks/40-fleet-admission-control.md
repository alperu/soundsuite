# Fleet routing spreads load but never refuses it — no admission control, no queue

**Status:** Proposed · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-09
**Report:** [`../MCP-Improvements/REPORT-v15-sidecar-model-awareness.md`](../MCP-Improvements/REPORT-v15-sidecar-model-awareness.md)
**Interacts with:** [task 38](./38-interactive-embedding-budget.md) (concurrency multiplies the budget gap) · [task 39](./39-role-aware-readiness.md)

Field names and code citations only. No case data.

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
| 1 | **Confirm before building.** Re-verify `:999`, `:1003-1015`, `:1078`, `:1147-1152`, and that `activeRequests` is still compared to no limit. Confirm `command-queue.ts` is a transport fallback, not an admission queue. | ☐ |
| 2 | **Measure the herd before fixing it.** Fire N simultaneous resolutions for a cold role and record how many select the same host. If they distribute acceptably in practice, the fix is smaller than the code path suggests — and if they do not, the measurement is the design input. | ☐ |
| 3 | **Reconcile the load counter.** A leaked `activeRequests` needs a floor: the sidecar already tracks `lastAcquire`/`lastRelease` per role (`sideCar/src/lib/state.ts:52-57`), so a stale-acquire sweep is cheaper than distributed bookkeeping. Prefer that to making release reliable. | ☐ |
| 4 | **Decide whether admission control is wanted at all**, and write the reasoning down. For a local single-operator system, queueing may be the wrong answer and a fast honest failure the right one. See the design note below. | ☐ |
| 5 | **If refusing: make the refusal legible.** A caller told "busy" must learn which role was saturated and roughly for how long. A bare 503 recreates the `notReady` defect — a signal that says nothing actionable. | ☐ |
| 6 | **Close the selection→acquire window** if item 2 shows it matters: optimistic increment on selection, or let `/acquire` return a rejection the router can retry elsewhere. Prefer the latter — the sidecar knows its own load better than a cache does. | ☐ |
| 7 | Cross-reference [task 38](./38-interactive-embedding-budget.md): add acquire time to its budget arithmetic and note the ×N concurrency factor. | ☐ |

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

## References

- `src/lib/gpu/fleet-router.ts:143, 999, 1003-1015, 1078, 1083+, 1147-1152`
- `src/lib/gpu/fleet-router.ts:601,606,611` (shared-Ollama port rewrite), `:891-897` (cached container config preferred over `ROLE_PORTS`)
- `src/lib/gpu/command-queue.ts` — transport fallback, not admission
- `src/lib/gpu/status-cache.ts` — the snapshot selection reads from
- `sideCar/src/lib/state.ts:19-51` (`ContainerDef`, incl. `vram`), `:52-57` (`PerRoleState`: `activeRequests`, `lastAcquire`, `lastRelease`)
- `src/lib/ingestion/ollama-embedding-provider.ts:174-182, 272-274` — per-request acquire/release
