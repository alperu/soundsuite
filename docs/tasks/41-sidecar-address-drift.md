# A sidecar's advertised address is pinned at first boot and never revalidated

**Status:** Proposed · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-13
**Reported:** `mcpserver.local` advertised `http://192.168.88.242:8098` after DHCP
moved the host to `192.168.88.238`. Restarting the sidecar did not correct it.
**Interacts with:** [task 39](./39-role-aware-readiness.md) (a role on an
unreachable host is not a role that is down) · [task 30](./30-mcp-parity-and-fleet-visibility.md)

Field names and code citations only. No case data.

## Verified before writing (2026-09-13)

Both halves of the reporter's hypothesis hold. Re-confirm in item 1 before
building — but these were read from source, not inferred.

### Sidecar: a saved address outranks reality

`sideCar/src/lib/ws-client.ts:51-70`, in order:

```ts
export function getAgentUrl(): string {
  if (process.env.AGENT_URL) return process.env.AGENT_URL;
  if (state.savedAgentUrl) return state.savedAgentUrl;        // <-- wins
  if (process.env.EXTERNAL_IP) return `http://${process.env.EXTERNAL_IP}:${PORT}`;
  // ...only now scan os.networkInterfaces()
}
```

`state.savedAgentUrl` is loaded from the persisted config at boot
(`config.ts:90-91`, "Loaded saved agent URL"), written back at `config.ts:206`,
and announced at `instrumentation.ts:145-146` ("Resuming with saved agentUrl").

**Nothing compares it against `os.networkInterfaces()`.** The three call sites are
`ws-client.ts:56` (only reached when `savedAgentUrl` is null), `handlers.ts:49`,
and `instrumentation.ts:33`. So the value is sticky for the life of the config
file, which is exactly why a restart did not help: boot reloads the stale value
before any detection runs.

### Master: identity *is* the address, and there is no update path

`src/lib/gpu/ws-relay.ts:291` keys the registry by the advertised address:

```ts
sidecars.set(msg.agentUrl, { ws, agentUrl: msg.agentUrl, hostname: ..., ... });
```

`hostname` is carried as a display field only. Grep for an update / rename /
migrate path over `agentUrl` in `src/app/api/admin/host-provisioning/route.ts` and
`src/app/api/admin/gpu-fleet/route.ts` returns **nothing**.

**Consequence:** if the sidecar ever does advertise a corrected address, the master
gains a *second* entry rather than updating the first, and the stale one persists
through `persistSidecarList()`. Fixing only the sidecar converts a wrong-address
bug into a duplicate-host bug.

## Verification pass results (2026-09-13, item 1) — read from source

Addresses shown below use RFC 5737 documentation ranges. The `sideCar/` tree is
published publicly, so nothing under it names real infrastructure.

**Held, exactly as written:** `ws-client.ts:51-70` precedence order ·
`config.ts:90-91` load / `:206` persist · `instrumentation.ts:145-146` resume log ·
`ws-relay.ts:288-296` registry keyed by `agentUrl` with `hostname` display-only ·
no master route updates an `agentUrl` (`host-provisioning/route.ts` upserts rows
keyed by `sidecarUrl`; `gpu-fleet/route.ts` offers add / remove / note only).

### REFUTED 1 — the writer of `savedAgentUrl` is not unknown

Item 1 hedged that "the original writer is unidentified" and that if nothing
wrote it the value "came from an older build". Both are wrong. The sole writer in
the tree is `sideCar/src/lib/self-update.ts:185`:

```ts
state.savedAgentUrl = getAgentUrl();   // immediately before the update restart
saveConfig();
```

It is **self-perpetuating**: at that line `getAgentUrl()` already returns
`state.savedAgentUrl` (it is checked second, `ws-client.ts:53`), so every
subsequent self-update re-pins the same address. That is the whole mechanism —
the address was pinned by whichever self-update ran while the host held it, and
each later upgrade re-committed it. `saveConfig()` is called from many places but
only ever persists whatever `state.savedAgentUrl` already holds, so a sidecar
that has **never self-updated** carries `agentUrl: null` and is unaffected.

Migration story therefore: "every host that has self-updated at least once is
pinned to the address it had at that moment", not "an older build wrote it".

### REFUTED 2 — `EXTERNAL_IP` does not currently win

The brief states `AGENT_URL` and `EXTERNAL_IP` "must keep winning". `AGENT_URL`
does. `EXTERNAL_IP` **does not** — `ws-client.ts:51-55` places `savedAgentUrl`
above it, so a pinned address already overrides an operator's deliberate
`EXTERNAL_IP`. Restoring `EXTERNAL_IP` above the saved value is a deliberate
behaviour change shipped with this fix, not an incidental one.

Target order: `AGENT_URL` → `EXTERNAL_IP` → detection → `savedAgentUrl`
(fallback) → `127.0.0.1`. With that order the "is this address still local?"
check becomes *structurally* unable to fire when either env var is set, rather
than depending on a conditional someone must remember.

### REFUTED 3 — item 10 needs no migration path; it is subsumed

`removeSidecar()` (`src/lib/gpu/fleet-router.ts:492`, wired at
`gpu-fleet/route.ts:114`) already closes the WS, block-lists the `agentUrl` for
60 s, drops the status-cache entry and rewrites the persisted list. The only
reason a delete did not stick is that the pinned sidecar re-advertised the same
stale address after the block expired. Once detection is primary (item 2) the
sidecar unpins itself, and the existing delete path is sufficient. Nothing new
was built for item 10.

### REFINED — the duplicate is worse than "a second entry"

The task says a corrected address yields a second registry entry. Confirmed, and
the leak is permanent on the *same-socket* path: `ws-relay.ts:276` reassigns
`registeredUrl = msg.agentUrl`, and the `close` handler (`:415-430`) only ever
deletes `registeredUrl`. So a re-register on a live socket leaves the **old key
holding a reference to that same live socket**, and nothing deletes it for the
life of the process — `persistSidecarList()` keeps writing it out, and
`hasSidecarConnection(oldUrl)` keeps answering true. This is the case item 5 has
to fix, and it is fixable without settling item 6.

### Out of scope, pre-existing, recorded not fixed

`persistSidecarList()` (`ws-relay.ts`) rebuilds `gpu.sidecars` wholly from the
live connection map, so operator-added entries and their `note` fields are
dropped on every register. Not a regression from this change.

## Why this is worse than a cosmetic display issue

The advertised address is what the master **calls**. `resolveEndpoint` hands it to
the data path, and `ollama-embedding-provider` and the rerank/RLM clients connect
to it directly. A stale address means:

- Every acquire against that host fails, or worse, hangs until a timeout.
- Under [task 39](./39-role-aware-readiness.md)'s role checks the host's roles read
  as **present** — the fleet reports it, so `checkRoleAvailability` sees a running
  container. Reachability and reported-status are different claims, and right now
  only one of them is made.
- With admission control ([task 40](./40-fleet-admission-control.md)) a host that
  cannot be reached still absorbs selection, because selection reads cached load.

## The hard part: what is a sidecar's identity?

Do not answer this by reflex. Each candidate is wrong in a different way.

| Candidate | Fails when |
|---|---|
| `agentUrl` (today) | DHCP moves the host — the reported bug |
| `hostname` | two hosts share a name (`localhost`, a cloned VM, two `mcpserver.local` on different subnets); also mutable |
| container id | changes on `docker rm` / recreate, which the auto-updater does |
| a generated persistent id | needs somewhere durable to live, and must survive config reset without colliding after a clone |

A generated id stored beside the config is probably right, but it inherits the
same staleness question the address has: a cloned VM carries its source's id. Any
choice must say what happens when two sidecars present the same identity.

## Work

Status legend: ☑ done · ◐ partially done, remainder named · ☐ not built.

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building** (four premises of v12 and three of v14 were refuted this way). Re-verify `ws-client.ts:51-70`, `config.ts:90-91,206`, `instrumentation.ts:145-146`, `ws-relay.ts:291`, and that no master route updates `agentUrl`. Also find **where `savedAgentUrl` is first written** — only the load path is visible, so the original writer is unidentified. If nothing writes it, the `.242` value came from an older build and that changes the migration story. | ☑ |
| 2 | **Decide whether a saved address should outrank detection at all.** The likely answer is no: make detection primary and treat the saved value as a fallback for when detection yields nothing useful. `AGENT_URL` and `EXTERNAL_IP` **must keep winning** — operators set those deliberately for NAT and multi-homed hosts, and breaking that is worse than the bug being fixed. | ☑ |
| 3 | **Revalidate at boot and on a timer.** At startup and every N heartbeats, compare the advertised address against `os.networkInterfaces()`. If the advertised host is not a local address, re-detect and re-advertise. Log the change loudly with both values — a silent address change is its own debugging problem. | ☑ |
| 4 | **Do not let a Docker-internal address win.** `ws-client.ts:58-62` already skips `172.17.`/`172.18.` and keeps them only as a last-resort fallback. Any re-detection must preserve that, or a containerised sidecar will advertise an address only it can reach. | ☑ |
| 5 | **Add a master-side reconcile path.** Same identity (item 6) arriving on a different `agentUrl` must **update** the entry, not create a second one: move the registry key, migrate `roles`/`vram`/`activeRequests`, close the old socket, and persist. This is where the duplicate-host bug gets prevented. | ◐ |
| 6 | **Choose the identity and write down what a collision does.** See the table above. Whatever is chosen, two sidecars presenting the same identity must produce a visible, named conflict rather than one silently replacing the other. | ☐ |
| 7 | **Give the operator a manual override.** `/admin/hostprov` already edits per-host master URL and WS port; add the ability to correct or forget a stale address, so recovery does not require editing a config file inside a container. | ☑ |
| 8 | **Distinguish unreachable from unreported.** A registry entry whose address does not answer should be visibly unreachable, not merely stale-looking. This is the same rule as [task 39](./39-role-aware-readiness.md): reported-status and reachability are separate claims, and the fleet currently only makes the first. | ☐ |
| 9 | Tests: a saved address that is no longer local is replaced; `AGENT_URL` still wins; a Docker-internal address is not preferred over a LAN one; a re-register from a new address updates rather than duplicates; a colliding identity is reported. | ☑ |
| 10 | **Clean up the entry that is already wrong.** `mcpserver.local` is registered at `.242` today. The fix must either migrate it or make removing it possible without hand-editing persisted state. | ☑ |

## What was built (2026-09-13)

### Sidecar — `sideCar/src/lib/agent-address.ts` (new, pure, imports nothing)

Holds every decision; takes the interface map, env and port as arguments so the
rules are testable without a host to run on.

- `resolveAgentUrl` — `AGENT_URL` → `EXTERNAL_IP` → detection → `savedAgentUrl` →
  `127.0.0.1`. Items 2 and the REFUTED-2 reorder.
- `detectAdvertisableAddress` — preserves the exact `172.17.`/`172.18.` demotion
  (item 4; deliberately **not** widened to 172.16/12, which would demote a real
  LAN on 172.20.x), and prefers a non-bridge address on the master's `/24` over
  "whichever the OS listed first" (the multi-homed risk).
- `advertisedHostLocality` — `local` / `not-local` / `unknown`. A URL whose host is
  not an IPv4 literal is `unknown` and never touched: a hostname cannot be checked
  against `os.networkInterfaces()` without resolution, and a name is operator intent.
- `AddressStabilityTracker` — N consecutive agreeing detections (default 3) before
  adoption; any disagreement restarts the count. The flap guard.
- `shouldReadvertise` — one tick. Returns `pinned-by-env` first, so the
  "is it local?" test is structurally unreachable when either env var is set.

### Sidecar — `ws-client.ts`

- `getAgentUrl()` now delegates and **caches**. It is called on every heartbeat
  via `buildFullStatus()`; re-running detection there would let a multi-homed host
  flap several times a minute. The value changes only through `revalidateAgentUrl()`.
- `initAgentAddress()` — called from `startGossipClient()` *before* the first
  `connectAllMasters()`, so a moved host never advertises the stale address even
  once. Logs pin → corrected and persists the correction.
- `revalidateAgentUrl()` — rides the existing 30 s watchdog. With the 3-sample
  debounce, **recovery after a DHCP move is bounded at ~90 s** (acceptance row 1).
  Logs both values loudly and emits a boot event.
- `reregisterOnLiveSockets()` — re-registers on the **live** socket rather than
  forcing a reconnect. That is what makes the master's decision unambiguous.
- `self-update.ts:185` keeps its write; a comment now records that it was the sole
  writer and why it is now a hint rather than a pin.

### Master — `src/lib/gpu/ws-relay.ts`

- `rekeySidecarAddress(oldUrl, newUrl, ws)` — exported, moves the registry key,
  migrates the status-cache entry (composed from `getSidecarStatus` →
  `updateSidecarStatus` → `removeSidecarFromCache`; no new helper added to
  `status-cache.ts`), carries `activeRequests` / `containers` / `hostname`.
- The register handler calls it when a `register` frame arrives on a socket
  **already registered under a different address**. Also fixes the permanent leak
  described under REFINED above.
- Collision: if the destination address is held by a *different* live socket, the
  move is **refused** — `logger.error` naming both hostnames, and a
  `{type:'registered', ok:false, error:'address-conflict: …'}` ack. Neither entry
  is replaced.
- The `hostProvisioning` row (keyed by `sidecarUrl`) follows the move, fire-and-
  forget; otherwise the master silently stops pushing identity to a host that only
  changed IP.

### Master — `PATCH /api/admin/host-provisioning` (item 7)

`{ fromSidecarUrl, toSidecarUrl }`: refuses if a row already exists at the
destination (409 — overwriting would lose that host's OS pin), moves the row, then
calls the existing `removeSidecar(from)` to close + block-list + forget the stale
entry. Recovery without hand-editing a config file inside a container.

It deliberately does **not** re-key a live socket. `registeredUrl` is a closure
variable in the connection handler; re-keying from a route would leave it pointing
at the old key and every subsequent heartbeat from that live sidecar would be
dropped, the entry going stale until the liveness sweep killed it. Closing instead
makes the sidecar reconnect and register its own (now revalidated) address.

### Item 5 is ◐ — 5a built, 5b needs item 6

- **5a (built):** a new address arriving on an **already-registered socket**. Same
  socket = same process, so the move is provable with no durable identity.
- **5b (not built):** the same sidecar reconnecting on a **fresh socket** from a new
  address. Indistinguishable from a new host without item 6. Today it registers as
  a new entry and the old one is removed by the liveness sweep — stale for one sweep
  interval rather than forever, which is the pre-existing behaviour, not a regression.

### Two dead ends closed during review

- **Loopback must not read as `local`.** A first draft short-circuited
  `127.0.0.1` to `local`. A sidecar whose network was not up at boot resolves to
  `http://127.0.0.1:8098`, caches it, and every later tick then stops at
  `still-local` — it would advertise loopback for the life of the process, and the
  pin-detection could not reach it. `listCandidates()` already filters `internal`,
  so loopback correctly falls out as `not-local` and re-detects. Covered by
  "escapes the loopback dead end once a real interface comes up".
- **`handlers.ts:48` had a second, disagreeing detector.** Item 1 named three
  interface-scan sites. `getPrimaryIp()` did its own first-non-internal-IPv4 walk
  with no bridge demotion, so on a multi-homed or containerised host `/api/status`
  could report a different address than the one advertised — a Docker bridge
  address among them. It now calls `detectAdvertisableAddress()`. One detector,
  not two. (`instrumentation.ts:33` keeps its own scan: it reports the
  *container-internal* IP as a boot diagnostic, which is a different claim.)

### Known gap under multi-master (not built)

`revalidateAgentUrl()` commits and persists the new address before any master
acks, and the sidecar's `registered` handler ignores `msg.ok`. With N masters, one
accepting while another refuses on `address-conflict` leaves the sidecar committed
to an address one master rejected. The conflict is named in that master's log, so
the acceptance row is met; an ack-checking rollback path belongs with 5b.

### Item 6 — options and collision behaviour, not decided

Not settled by evidence, so per the brief it is written down rather than guessed.
All three need a wire-format change (`register` gains an id field) plus a master
column, so none is a drop-in.

| Option | Durable across | Breaks on | Collision behaviour required |
|---|---|---|---|
| **A. uuid in `config.json`**, generated on first boot | restart, DHCP move, `docker rm` (config is volume-mounted) | config reset / volume GC → looks like a new host; **VM or container-image clone → two hosts share one id** | Second claimant refused, both hostnames named, operator must clear one config. Cannot self-heal: neither side knows which is the clone. |
| **B. uuid + machine fingerprint** (`/etc/machine-id`, or Docker host id via `/info`) | as A, and a clone differs if the fingerprint does | fingerprint unavailable in some containers; `machine-id` is itself cloned by naive VM copies | Same id + different fingerprint → treat as distinct, log the split. Same id + same fingerprint → genuine duplicate, refuse. |
| **C. operator-assigned name** in `/admin/hostprov` | anything — it is declared, not derived | needs an operator action per host; a typo collides silently | Refuse the second claim at assignment time (unique constraint), which is the only option where the collision is caught *before* traffic. |

Recommendation to settle it: **B for the automatic path, C as the override** — B
recognises a moved host without operator action, C is the escape hatch when B's
fingerprint is unavailable or a clone must be split. Whatever is chosen, the
refuse-and-name behaviour built in 5a's conflict branch is the template: a
collision is a named, logged conflict with an `ok:false` ack, never a silent
replacement.

### Item 8 — deliberately not built

Unreachable-vs-unreported is [task 39](./39-role-aware-readiness.md)'s split, and
active work on tasks 39/30 owns that surface. Building a second reachability
notion here would collide with it. The final acceptance row stays unmet.

## Risks

- **Re-detection on a multi-homed host can pick the wrong interface.** The current
  code returns the *first* non-internal IPv4 it finds, which is arbitrary on a host
  with several. Re-detecting more often makes that instability more visible, not
  less. Prefer the interface that can reach the master over the first one listed.
- **A flapping address is worse than a stale one.** If detection disagrees with
  itself between runs, the master will see the identity move back and forth and
  (with item 5) migrate state each time. Require stability before re-advertising.
- **Changing the registry key touches persistence.** `persistSidecarList()` and the
  `data/` records both carry `agentUrl`. A migration that half-completes leaves two
  records for one host, which is the bug this task exists to prevent.
- **Do not break the deliberate pin.** A host behind NAT advertises an address that
  is *not* one of its local interfaces, and that is correct. Item 3's "is it local?"
  test must not fire when `AGENT_URL` or `EXTERNAL_IP` is set.

## Acceptance

| Check | Expected |
|---|---|
| DHCP moves a sidecar host | the master reaches it again without operator action, within a stated bound |
| The same host after the move | **one** registry entry, not two |
| `AGENT_URL` set to a non-local address | honoured, never overridden |
| A containerised sidecar with only a `172.17.x` address | does not advertise it while a LAN address exists |
| Two sidecars with the same identity | a named conflict, not silent replacement |
| A registered address that does not answer | reported unreachable, distinct from unreported |

## References

- `sideCar/src/lib/ws-client.ts:51-70` (`getAgentUrl`), `:162` (register payload), `:1022-1024`
- `sideCar/src/lib/config.ts:90-91` (load), `:206` (persist)
- `sideCar/src/instrumentation.ts:145-146` (resume log), `:33` (interface scan)
- `sideCar/src/lib/handlers.ts:49` (interface scan), `:1076` (status exposure)
- `src/lib/gpu/ws-relay.ts:291` (registry keyed by `agentUrl`), `persistSidecarList()`
- `src/app/api/admin/host-provisioning/route.ts` — per-host master URL / WS port, no address update
- `src/app/api/admin/gpu-fleet/route.ts` — fleet read surface

Added by this change:

- `sideCar/src/lib/agent-address.ts` — all address decisions, pure, no imports
- `sideCar/src/lib/ws-client.ts` — `getAgentUrl` (cached), `initAgentAddress`,
  `revalidateAgentUrl`, `reregisterOnLiveSockets`; revalidation wired into the 30 s
  watchdog in `startWatchdog()` and `initAgentAddress()` into `startGossipClient()`
- `sideCar/src/lib/self-update.ts:184-193` — comment recording the sole writer
- `sideCar/src/lib/handlers.ts:48` — `getPrimaryIp()` now shares the one detector
- `src/lib/gpu/ws-relay.ts` — `rekeySidecarAddress()` + the register-handler move
- `src/app/api/admin/host-provisioning/route.ts` — `PATCH` address correction
- `src/lib/gpu/__tests__/sidecar-agent-address.test.ts` — 25 tests
- `src/lib/gpu/__tests__/ws-relay-address-move.test.ts` — 5 tests over the real relay

Sidecar logic is tested from the **root** suite by relative import: `sideCar/` has
no test runner at all (its package ships only next/react/ws), and the release
script owns its `package.json`. The import must stay relative — root jest maps
`@/` to the root `src/`, so an `@/` specifier inside the sidecar tree resolves
into the wrong project.
