# A "Restart Sidecar" button in the sidecar's own UI

**Status:** Implemented (2026-09-13) · **Effort:** S · **Priority:** P2 · **Created:** 2026-09-13
**Asked for:** a button immediately **left of `Setup`** on the sidecar dashboard
that restarts the sidecar's own Docker container.
**Why now:** restarting the sidecar has twice been the thing that actually cleared
a stuck state, and doing it currently requires shell access to the host — which is
exactly what an operator does not have when a host is misbehaving.

Field names and code citations only. No case data. **`sideCar/` is published
publicly** — no real addresses or hostnames in anything under it. Use RFC 5737
(`192.0.2.x`) and invented names.

## Scope — and one thing that is explicitly NOT in scope

**In scope:** restarting the **sidecar's own container** (`ss-sidecar`).

**Not in scope:** restarting the **Docker daemon / Docker Desktop**. A container
cannot restart the engine it runs on — it would be terminating its own execution
environment, and on macOS and Windows the daemon lives in a VM the container has
no authority over. That already exists as an operator action elsewhere
(`build/docker/docker-ctl.sh` in the OliveTin repo, over SSH). Do not attempt it
here, and say so in the UI if the distinction could confuse anyone.

## Verification pass — what held and what did not

**Confirmed:**

- `sideCar/src/lib/docker.ts:415` `startContainer()`, `:428` `stopContainer()`,
  `:475` `removeContainer()` — exact. **No `restartContainer()` existed**; added.
- `sideCar/src/app/page.tsx:443` — the literal `Setup` text, inside the
  `<a href="/setup">` opening at `:438`. The new control goes before that anchor.
- The sidecar runs with `/var/run/docker.sock` mounted, so it can call the Docker
  API against its own container. `POST /containers/{id}/restart` works on the
  caller's own container; the daemon performs the kill and start.

**REFUTED — 1: `CONTAINER_NAME` does not mean "self", and the proposed
cross-check would have refused every restart.**
`state.ts:383` reads `CONTAINER_NAME: process.env.CONTAINER_NAME || 'vllm-reranker'`,
and `handlers.ts:1042` consumes it as `container: containers.reranker || await
getContainerState()` — it is the *legacy handle for the managed reranker
container*, not the sidecar's own name. So the original hazard-1 remedy ("refuse
when the resolved identity and `CONTAINER_NAME` disagree") would refuse **on the
default configuration**, every time: a button that can never fire. The acceptance
row "`CONTAINER_NAME` set to a sibling `ss-*` → refused" was describing the
default state, not an edge case.

The guard that actually discriminates, and that no env var can defeat: refuse when
the **resolved** self-name is in the set of containers the sidecar *manages* —
every `state.registry[*].containerName` plus `state.CONTAINER_NAME` itself.
Critically this is **not** a `ss-` prefix rule: the sidecar's own container is
conventionally `ss-sidecar`, so a prefix rule would refuse every legitimate
restart. `docker.ts` `managedContainerNames()` carries that reasoning in a comment
because it is the subtlety most likely to be "simplified" away later.

**REFUTED — 2: `/api/diag/volume-mount` is not a Docker-socket probe.**
It is `getConfigVolumeKind('/app/config')` (`diag.ts:44`) — it classifies how the
*config directory* is mounted, to warn operators about losing their master list.
It says nothing about Docker reachability. The real primitives already in the repo
are `isDockerAvailable()` (`docker.ts:204`) and `pingDocker()` (`:23`); the
resolver uses the former. No second probe was written.

**REFUTED — 3: the refusal set was missing a case.**
`npm run dev` / `npm start` runs the sidecar bare-metal on port 8098 with no
container at all. That needs its own reason (`not-in-container`), not a generic
one — the fix is "restart the process how you started it", which no other refusal
implies.

**REFUTED — 4: there was no test harness for `sideCar/` at all.**
Root `jest.config.js` has `roots: ['<rootDir>/src']`, which excludes this subtree,
and `sideCar/package.json` carries no test dependencies. Added
`sideCar/jest.config.js` (overriding the `esnext`/`bundler`/`isolatedModules`
tsconfig, which Jest cannot run), driven by the root's jest install:
`npx jest --config sideCar/jest.config.js`. **Still needed, outside this task's
territory:** a `test` script in `sideCar/package.json`.

**Also found, and reused rather than rebuilt:**

- `src/app/api/update/route.ts` already solves the respond-then-act problem
  (`setTimeout(..., 100)` after returning, because `performUpdate` calls
  `process.exit`). `/api/restart` mirrors it. Note that `/api/update` relies on
  the container's restart policy to come back; the Docker restart endpoint does
  not, which is why it is not substituted here.
- `page.tsx` already tracks `bootEpoch` — the sidecar's stable per-process boot
  epoch — to reset boot-log dedup across a restart. That is a far better recovery
  signal than "did `/api/health` answer": a reachable endpoint may still be the
  *pre-restart* process. The UI waits for a **different** epoch.

## The two things that will make this dangerous if done carelessly

**1. Do not trust `CONTAINER_NAME` to identify "self"** — see REFUTED 1 for why
the original cross-check does not work and what replaced it. Resolution reads the
runtime: `/proc/self/mountinfo` carries `/var/lib/docker/containers/<64-hex>/`
because Docker bind-mounts `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf`
from there, and nothing inside the container can forge that — not `--hostname`,
not an env var. The in-container hostname (Docker defaults it to the 12-hex short
ID) corroborates it; when the two name different containers, or mountinfo names
several, the answer is a refusal, not a guess. `/proc/self/cgroup` is deliberately
**unused**: under cgroup v2 it commonly reads `0::/` with no ID in it.

A free extra check falls out of `createContainer` setting `Hostname: name`
(`docker.ts:636`): a managed sibling reports `ss-reranker`, never 12-hex. So a
12-hex hostname is itself weak evidence of not-a-sibling, and the managed-set
check closes the rest.

**2. The response cannot be delivered after the restart starts.** Respond first —
`202 Accepted` with the resolved target — then schedule the restart on a short
delay so the response actually flushes. A further consequence: the restart call's
own socket dies mid-request, so its rejection is indistinguishable from a request
that never landed. It is logged as "expected", never as a failure, and the outcome
comes only from the container returning.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building.** | ☑ Done — four premises refuted; see the verification pass above. |
| 2 | **Add `restartContainer(id, t)`** — `docker.ts:486`, `POST /containers/{id}/restart?t=`, not stop-then-start. | ☑ |
| 3 | **Resolve "self" from the runtime** — `resolveSelfContainer()` `docker.ts:600`, with injectable `SelfProbes` so every branch is testable without Docker and without being in a container. Returns the resolved id/shortId/name, which source identified it, and whether the two sources corroborated. | ☑ |
| 4 | **`POST /api/restart`** — `202` with the target, restart issued 250 ms later. | ☑ |
| 5 | **Named refusals** — five codes: `docker-unreachable`, `not-in-container`, `self-unresolvable`, `sources-disagree`, `resolved-is-managed`. `resolved-is-managed` and `sources-disagree` both name *both* identities. | ☑ |
| 6 | **Button left of `Setup`** with a two-step confirmation naming the container and short ID, plus which runtime source identified it. | ☑ |
| 7 | **Honest UI.** The `202` only logs "accepted … this is not a success signal yet". Recovery is confirmed by a **changed `bootEpoch`** (emitted at `handlers.ts:1096`) on the existing 3 s `/api/status` poll, not by reachability — a reachable endpoint may still be the pre-restart process. A transport error on the POST is treated as ambiguous, not as failure. The `restarting` state is **bounded at 3 minutes**: without a bound, a sidecar that never comes back leaves the UI pulsing "Restarting…" with the button gone and feasibility never refetched, recoverable only by a manual reload. On timeout it says the outcome is unconfirmed rather than implying either result. | ☑ |
| 8 | **Disabled with the reason in a tooltip**, driven by `GET /api/restart`. (The `GET` was not in the original plan — item 8 is unbuildable without it, since `/api/status` is off-territory.) Feasibility is refetched via an explicit `refreshRestartInfo()` on mount, on refusal, on recovery and on timeout — *not* via a `restartState` effect dependency, which React can batch away and leave a stale `canRestart: true` re-enabling the button against a target that no longer exists. | ☑ |
| 9 | Tests — 33 passing across three suites. | ☑ |

### Added `GET /api/restart`

Item 8 needs feasibility *before* the click. `/api/status/route.ts` was held by
another agent, so the same new route file answers `GET` with
`{ canRestart, reason, detail, target, note, counters }`.

### Files

- `sideCar/src/lib/docker.ts` — `restartContainer()`, `resolveSelfContainer()`,
  `managedContainerNames()`, `defaultSelfProbes`, the `SelfRefusalCode` union.
- `sideCar/src/app/api/restart/route.ts` — new.
- `sideCar/src/app/page.tsx` — `RestartFeasibility` type, restart state/refs,
  feasibility effect, `handleRestart`, the `bootEpoch` recovery check inside the
  existing poll, the button, and the confirmation panel.
- `sideCar/jest.config.js` — new; the sidecar's first test harness.
- `sideCar/src/lib/__tests__/self-restart-resolve.test.ts`,
  `sideCar/src/app/api/restart/__tests__/route.test.ts`,
  `sideCar/src/lib/__tests__/harness-smoke.test.ts` — new.
- `sideCar/docs/API.md` — `GET`/`POST /restart`, the refusal table, the
  engine-vs-container distinction, the `/reset-counters` pointer, and the no-auth
  note amended to mention self-restart.

Not built, deliberately: no auth scheme (out of scope, as the task says); no
`activeRequests` persistence (`/reset-counters` is the remedy); no engine restart;
no automatic trigger anywhere.

## Risks

- **Restarting the sidecar does not restart the model containers, and should not.**
  Host-Ollama and DMR roles are unaffected by design. If an operator expects a
  restart to clear a stuck *model*, this button will look like it did nothing —
  worth a word in the UI.
- **A restart loses in-flight `activeRequests` accounting.** The counters live in
  memory; the master's view of them does not. This is the leak task 40 describes,
  triggered deliberately. `POST /reset-counters` already exists as the remedy —
  mention it rather than re-implementing it.
- **No authentication.** The sidecar has none by design (`docs/API.md` says so), so
  this adds a remote restart to an unauthenticated surface. That is consistent with
  `/start`, `/stop` and `/provision`, which already control containers — but it
  raises the value of keeping the sidecar off untrusted networks. Note it in
  `docs/API.md`; do not invent an auth scheme in this task.
- **Do not restart on any automatic trigger.** Operator-initiated only. A sidecar
  that restarts itself in response to a condition can loop, and a restart loop on a
  remote host is very hard to break.

## Acceptance

| Check | Expected | Covered by |
|---|---|---|
| Button pressed with the socket mounted | the sidecar's own container restarts; UI recovers on its own | not machine-verifiable without a live restart — deliberately never issued from tests. Resolver + ordering + recovery signal each tested separately. |
| ~~`CONTAINER_NAME` set to a sibling `ss-*`~~ → **resolved identity** is a managed container | refused, both identities named; nothing restarted | `self-restart-resolve.test.ts` (8 managed names, incl. the `vllm-reranker` default) and `route.test.ts` ("refuses 409 naming both identities") |
| A name sharing the `ss-` prefix but not managed (`ss-sidecar`) | **allowed** — a prefix rule would refuse everything | `self-restart-resolve.test.ts` "does not refuse merely because the name starts with the ss- prefix" |
| No Docker socket mounted | button disabled, reason shown | `docker-unreachable` branch + the `GET` feasibility test |
| Running bare-metal (`npm run dev`) | refused as `not-in-container`, with "restart the process how you started it" | `not-in-container` branch |
| The response | arrives before the restart, and does not claim success | `route.test.ts` — asserts `restartContainer` has **not** been called when the `202` exists, then that it is called with the resolved ID once the delay elapses |
| Any sibling model container | never targeted | every refusal test asserts `restartContainer` was not called at all |
| Docker call shape | the restart endpoint, never stop-then-start | `restartContainer` test asserts the single `POST …/restart?t=10` and that no `/stop` or `/start` call was made |

**Not verified against a live sidecar.** The fleet was off-limits for this task and
no restart was ever issued. `resolveSelfContainer` takes injected probes precisely
so its mountinfo/hostname branches are exercised with fakes; the one thing that
needs a real container is the end-to-end restart, and the first press on a real
host is the remaining check. A release build (`./scripts/buildSidecar.sh patch`)
is needed before that press — not run here.

## References

- `sideCar/src/lib/docker.ts:415` (`startContainer`), `:428` (`stopContainer`), `:475` (`removeContainer`)
- `sideCar/src/app/page.tsx:443` — the `Setup` control
- `sideCar/src/app/api/diag/volume-mount/route.ts` — **not** a Docker-socket check
  (see REFUTED 2). Docker reachability is `docker.ts:204` `isDockerAvailable()`.
- `sideCar/src/app/api/reset-counters/route.ts` — the counter remedy after a restart
- `sideCar/docs/API.md` — endpoint reference to update
- OliveTin `build/docker/docker-ctl.sh` — where *engine* start/stop/restart lives, out of scope here
