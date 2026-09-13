# A "Restart Sidecar" button in the sidecar's own UI

**Status:** Proposed · **Effort:** S · **Priority:** P2 · **Created:** 2026-09-13
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

## Feasibility — confirmed

The sidecar runs with `/var/run/docker.sock` mounted, so it can call the Docker
API against its own container. `POST /containers/{id}/restart` works on the
caller's own container; the daemon performs the kill and start, not the container.

Existing pieces:

- `sideCar/src/lib/docker.ts:415` `startContainer()`, `:428` `stopContainer()`,
  `:475` `removeContainer()` — **there is no `restartContainer()`**; one must be
  added.
- `sideCar/src/app/page.tsx:443` — the `Setup` control the new button goes left of.
- `state.CONTAINER_NAME` (env `CONTAINER_NAME`, default `ss-sidecar`) is how the
  sidecar refers to itself today.

## The two things that will make this dangerous if done carelessly

**1. Do not trust `CONTAINER_NAME` to identify "self".** It is an env var an
operator can set, and the sidecar also manages sibling containers named
`ss-embedding`, `ss-ocr`, `ss-reranker`, `ss-rlm`. A wrong value turns a restart
button into "stop a model container" with no indication that is what happened.
**Resolve self from the runtime, then cross-check**: the container's own ID is
observable (the in-container hostname is the short container ID — a live sidecar
reports `hostname: <12-hex>`), and `/proc/self/cgroup` or `/proc/self/mountinfo`
carries it on Linux. Restart by resolved ID, and if the resolved identity and
`CONTAINER_NAME` disagree, **refuse and report both** rather than guessing.

**2. The response cannot be delivered after the restart starts.** Respond first —
`202 Accepted` with what is about to happen — then schedule the restart on a short
delay so the response actually flushes. A handler that calls restart and then tries
to return will simply appear to hang, and the operator will not know whether it
worked.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building.** Verify `docker.ts:415,428,475` and that no `restartContainer` exists; verify `page.tsx:443` is the `Setup` control; verify the Docker socket is genuinely reachable at runtime (`/api/diag/volume-mount` already tests this — reuse it rather than writing a second probe). | ☐ |
| 2 | **Add `restartContainer(id)`** to `docker.ts`, using the Docker API's restart endpoint rather than stop-then-start. Stop-then-start is two round trips with a window where a crash leaves the container down — and a container cannot reliably issue the second call after stopping itself. | ☐ |
| 3 | **Resolve "self" from the runtime**, per hazard 1. Expose the resolved identity so the UI can name what it is about to restart. | ☐ |
| 4 | **Add `POST /api/restart`.** Respond `202` before restarting. Include the resolved container ID and name in the response so the caller can confirm the right target. | ☐ |
| 5 | **Refuse, with a reason, when it cannot work.** No Docker socket mounted, self not resolvable, or resolved identity disagreeing with `CONTAINER_NAME` — each gets a distinct, named refusal. A generic failure here is the `notReady` defect again: a signal that says nothing actionable. | ☐ |
| 6 | **Add the button left of `Setup`** (`page.tsx:443`). Require a confirmation step — it drops every master connection for a few seconds. State in the confirmation *which* container will restart, by name and short ID. | ☐ |
| 7 | **Make the UI honest about what follows.** The page will lose its connection. Show "restarting…", poll `/api/health` until it answers, then reload. Do **not** claim success on the `202` — that reports the request, not the outcome. | ☐ |
| 8 | **Disable the button when restart is impossible**, with the reason in a tooltip, rather than offering a control that will fail. | ☐ |
| 9 | Tests: `restartContainer` targets the resolved ID; a disagreement between resolved identity and `CONTAINER_NAME` refuses; a missing Docker socket refuses with its own reason; the route responds before restarting; the route never targets a sibling `ss-*` container. | ☐ |

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

| Check | Expected |
|---|---|
| Button pressed with the socket mounted | the sidecar's own container restarts; UI recovers on its own |
| `CONTAINER_NAME` set to a sibling `ss-*` container | refused, both identities named; nothing restarted |
| No Docker socket mounted | button disabled, reason shown |
| The response | arrives before the restart, and does not claim success |
| Any sibling model container | never targeted |

## References

- `sideCar/src/lib/docker.ts:415` (`startContainer`), `:428` (`stopContainer`), `:475` (`removeContainer`)
- `sideCar/src/app/page.tsx:443` — the `Setup` control
- `sideCar/src/app/api/diag/volume-mount/route.ts` — existing Docker-socket check
- `sideCar/src/app/api/reset-counters/route.ts` — the counter remedy after a restart
- `sideCar/docs/API.md` — endpoint reference to update
- OliveTin `build/docker/docker-ctl.sh` — where *engine* start/stop/restart lives, out of scope here
