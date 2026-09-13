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

> **Superseded in part.** The VPN constraint below arrived after this section was
> written and overturns REFUTED 2's conclusion and REFUTED 3 entirely. Read
> "Reframing: the master must observe, not the sidecar declare" before acting on
> either. The observations in both still hold; the *conclusions* drawn from them
> did not survive.

### REFUTED 2 — `EXTERNAL_IP` does not currently win

The brief states `AGENT_URL` and `EXTERNAL_IP` "must keep winning". `AGENT_URL`
does. `EXTERNAL_IP` **does not** — `ws-client.ts:51-55` places `savedAgentUrl`
above it, so a pinned address already overrides an operator's deliberate
`EXTERNAL_IP`. Restoring `EXTERNAL_IP` above the saved value is a deliberate
behaviour change shipped with this fix, not an incidental one.

The order first proposed here — `AGENT_URL` → `EXTERNAL_IP` → detection →
`savedAgentUrl` → `127.0.0.1` — **is not what shipped.** Putting detection above
the persisted value is refuted by the VPN case below. Shipped order:
`AGENT_URL` → `EXTERNAL_IP` → `savedAgentUrl` → detection → `127.0.0.1`.
Only the `EXTERNAL_IP` inversion is corrected.

### REFUTED 3 — item 10 needs no migration path; it is subsumed

`removeSidecar()` (`src/lib/gpu/fleet-router.ts:492`, wired at
`gpu-fleet/route.ts:114`) already closes the WS, block-lists the `agentUrl` for
60 s, drops the status-cache entry and rewrites the persisted list. The only
reason a delete did not stick is that the pinned sidecar re-advertised the same
stale address after the block expired.

**This conclusion is itself now refuted.** It rested on "once detection is primary
the sidecar unpins itself" — and detection is deliberately *not* primary (see the
VPN reframing). A pinned host therefore keeps re-advertising its stale address
after the 60 s block expires, so `removeSidecar()` clears the master's view but
does not fix the host. **Item 10 is not solved.** The two real recovery paths:

- **Available today:** set `AGENT_URL` or `EXTERNAL_IP` on the sidecar container.
  Both now correctly outrank the persisted pin (that is the `EXTERNAL_IP` fix), so
  this works on the next container start without touching config inside the container.
- **The right fix, designed not built:** the master already pushes a
  `master-identity` frame that the sidecar persists. The same channel can push a
  *corrected agentUrl* derived from the observed peer address. That is the clean
  recovery — no operator action, no shell inside a container — but it adds a
  master→sidecar config-mutation path, and pushing an address that has not been
  probe-validated could take a host dark exactly like the re-detection would have.
  It needs the probe first. Not built deliberately.

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

## Reframing: the master must observe, not the sidecar declare (2026-09-13)

New constraint from the user, which invalidates part of this task as written and
part of what was first built against it: **the master is sometimes on a VPN, and a
sidecar host is reachable at a different address depending on the path.** The same
hosts appear as private LAN addresses, as VPN DNS names, and as Tailscale CGNAT
addresses in `100.64.0.0/10`. `mcpserver.local` is an mDNS name, and **mDNS does
not cross a VPN** — multicast is not forwarded — so a `.local` name that resolves
on the LAN fails over the VPN and the host looks *down* rather than misaddressed.

There is therefore **no single correct address for the sidecar to advertise.** The
right one depends on which network the master is on right now, which the sidecar
cannot know.

### REFUTED (the task's own item 3, written before the VPN was known)

> "At startup and every N heartbeats, compare the advertised address against
> `os.networkInterfaces()`. If the advertised host is not a local address,
> re-detect and re-advertise."

Wrong as written, in three separate ways:

1. A **VPN DNS name** is not an IP literal, so there is nothing to compare.
2. A **Tailscale address is local** (it is a real address on `tailscale0`) yet is
   not the LAN address — so "is it local?" says yes for an address that only works
   over the VPN, and yes for the LAN one too. The test cannot discriminate.
3. A **NAT'd address is correctly non-local**, so the test fires on exactly the
   case where the operator's pin must be honoured.

### REFUTED (my own, from the first implementation of item 3)

The `/24` tie-break ("prefer the interface on the master's subnet") is **near
useless for Tailscale**: it hands each node a scattered `/32` inside
`100.64.0.0/10`, so a master at `100.64.5.7` shares no `/24` with a node at
`100.64.91.3`. Detection then falls back to "first non-bridge in OS order" and
picks the **LAN** address for a VPN-side master.

**This was a fleet-outage bug in the first draft of this work.** `initAgentAddress()`
ran at boot, before the first register, and overwrote the persisted pin with that
detected address. A host reachable only over the VPN would have been re-pinned to
a LAN address the master cannot reach, gone dark, and been unrecoverable without
editing config inside a container on a machine that was by then unreachable —
across the whole fleet at once, since sidecars auto-update. It was removed before
anything shipped. Nothing now calls it.

### REFUTED — item 2's premise, and my own REFUTED 2 conclusion

Item 2 proposed "make detection primary, saved value as fallback… the likely
answer is no [saved should not outrank detection]". That is wrong under multi-path.
A persisted address **has at least once reached a master**; a detected address has
been validated by nothing at all. Preferring the unvalidated one is a regression
dressed as a fix.

So the shipped order is `AGENT_URL` → `EXTERNAL_IP` → `savedAgentUrl` → detection
→ loopback. Only the `EXTERNAL_IP` inversion — a genuine bug, an operator's
deliberate setting being silently overridden — is corrected. **No host's advertised
address changes in this release** unless `EXTERNAL_IP` was being wrongly overridden.

### The design that does work: observe the peer address

The master holds the socket, and the relay owns its own listener
(`new WebSocketServer({ port: WS_PORT })`, `ws-relay.ts:293`) with **no proxy in
front** — so `req.socket.remoteAddress` in the `connection` handler is the true
peer address. By construction that is the address the sidecar reached this master
*from*, and therefore correct for whichever path is in use. It is immune to DHCP
drift, to multi-homing, and to mDNS not crossing the VPN. No sidecar-side heuristic
can match it, because only the master knows which network it is on.

**Prior art confirming the shape:** `SidecarEntry.lastSeenFromIp` already exists and
is populated on the HTTP register path (`src/app/api/admin/gpu/sidecars/register/route.ts:61`)
— recorded and never used. Note it reads only `x-forwarded-for` / `x-real-ip`, so it
is **empty with no proxy in front**; the WS path reads the socket directly and is
strictly better evidence.

Known limits, which is why this is recorded and not yet routed on:

- The peer address is a usable callback target only if the sidecar's **port** is
  reachable at it. Behind NAT or a one-way tunnel it is the translated address with
  no forwarded port — so `AGENT_URL` / `EXTERNAL_IP` must keep winning.
- The **port** must come from the sidecar's declared `agentUrl` / `AGENT_PORT`; the
  source port is ephemeral.
- IPv4-mapped IPv6 (`::ffff:192.0.2.1`) needs normalising — done.

The full shape, for the next stage: the sidecar advertises **candidates** (its
detected addresses plus any pin), the master prefers the **observed** peer address,
and probes down the candidate list when it does not answer. That also answers
item 8 for free — a candidate that does not answer is *unreachable*, a different
and more useful claim than *unreported*.

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

## ⚠️ CORRECTION — what 2.3.77 actually shipped (2026-09-13)

Commit `6a4e0004`'s message describes a **first draft that was withdrawn**, not the
code it commits. Recorded here because that message would otherwise be read as
documentation of shipped behaviour.

**The message claims** detection is primary, revalidation runs on the 30 s
watchdog, and recovery is bounded at ~90 s. **None of that is in the build.**
`sideCar/src/lib/ws-client.ts:1449` says so explicitly — *"DELIBERATELY NOT
CALLED: initAgentAddress() / revalidateAgentUrl()"* — and the shipped precedence
in `agent-address.ts` is:

```
AGENT_URL → EXTERNAL_IP → savedAgentUrl → detection → loopback
```

`savedAgentUrl` still outranks detection. **No host's advertised address changes
by itself in 2.3.77.**

### Why the draft was withdrawn — it was a fleet-outage bug

The `/24` tie-break is near-useless on Tailscale: it hands out scattered `/32`s
inside `100.64.0.0/10`, so a master at `100.64.5.7` shares no `/24` with a node at
`100.64.91.3`. Detection then falls through to "first non-bridge address in OS
order" and picks the **LAN** address. A VPN-only host would have gone dark —
unrecoverable without a shell inside a container on a machine that is by then
unreachable, and fleet-wide at once via auto-update.

### What 2.3.77 does contain

- **`EXTERNAL_IP` now outranks `savedAgentUrl`.** It previously sat *below* the
  pin, so a deliberate operator setting was silently overridden. This is the one
  behaviour change on the sidecar side, and it is the supported recovery path.
- Master-side `rekeySidecarAddress()` and the `PATCH /api/admin/host-provisioning`
  correction endpoint.
- `handlers.ts` and `ws-client.ts` now share one address detector, so `/api/status`
  cannot report a different address than the one advertised.

### Consequences for the open items

- **Item 10 is NOT solved.** An earlier note claimed it was subsumed because "the
  sidecar unpins itself". It does not. `removeSidecar()` clears the master's view
  and the host re-advertises the same pinned address after the 60 s block expires.
  **Today's real recovery is `EXTERNAL_IP` or `AGENT_URL` set on the host**, or the
  new `PATCH` endpoint.
- The original **item 3** ("is the advertised host still local?") is wrong three
  ways and must not be built as written: a VPN DNS name is not an IP literal; a
  Tailscale address *is* local but is not the LAN one, so the test cannot
  discriminate; and a NAT'd address is correctly non-local, so the test fires
  exactly where the pin must be honoured.

### Identity (item 6) — decided

Hostname is out, and the VPN supplies a reason beyond collisions: a `.local` name
that fails over a VPN looks like the host being *down*. **The socket is the
identity** for a connection's duration — unspoofable, unclonable, and already what
`rekeySidecarAddress()` relies on. A generated persistent id is **deferred**: with
the peer address observed master-side, recognising a sidecar across connections
buys much less, and a cloned VM would carry its source's id anyway.

### Master-side observation, recorded but not routed on

`wss.on('connection', (ws, req))` now records the normalised
`req.socket.remoteAddress` as `observedFromIp` / `lastSeenFromIp`. **It is recorded,
not used for routing.** Switching the data path onto it needs probe-and-fallback,
and `resolveEndpoint` lives in `fleet-router.ts`. That remains open.

## Work

Status legend: ☑ done · ◐ partially done, remainder named · ☐ not built.

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building** (four premises of v12 and three of v14 were refuted this way). Re-verify `ws-client.ts:51-70`, `config.ts:90-91,206`, `instrumentation.ts:145-146`, `ws-relay.ts:291`, and that no master route updates `agentUrl`. Also find **where `savedAgentUrl` is first written** — only the load path is visible, so the original writer is unidentified. If nothing writes it, the `.242` value came from an older build and that changes the migration story. | ☑ |
| 2 | **Decide whether a saved address should outrank detection at all.** The likely answer is no: make detection primary and treat the saved value as a fallback for when detection yields nothing useful. `AGENT_URL` and `EXTERNAL_IP` **must keep winning** — operators set those deliberately for NAT and multi-homed hosts, and breaking that is worse than the bug being fixed. | ◐ |
| 3 | **Revalidate at boot and on a timer.** At startup and every N heartbeats, compare the advertised address against `os.networkInterfaces()`. If the advertised host is not a local address, re-detect and re-advertise. Log the change loudly with both values — a silent address change is its own debugging problem. | ☐ |
| 4 | **Do not let a Docker-internal address win.** `ws-client.ts:58-62` already skips `172.17.`/`172.18.` and keeps them only as a last-resort fallback. Any re-detection must preserve that, or a containerised sidecar will advertise an address only it can reach. | ☑ |
| 5 | **Add a master-side reconcile path.** Same identity (item 6) arriving on a different `agentUrl` must **update** the entry, not create a second one: move the registry key, migrate `roles`/`vram`/`activeRequests`, close the old socket, and persist. This is where the duplicate-host bug gets prevented. | ◐ |
| 6 | **Choose the identity and write down what a collision does.** See the table above. Whatever is chosen, two sidecars presenting the same identity must produce a visible, named conflict rather than one silently replacing the other. | ☐ |
| 7 | **Give the operator a manual override.** `/admin/hostprov` already edits per-host master URL and WS port; add the ability to correct or forget a stale address, so recovery does not require editing a config file inside a container. | ☑ |
| 8 | **Distinguish unreachable from unreported.** A registry entry whose address does not answer should be visibly unreachable, not merely stale-looking. This is the same rule as [task 39](./39-role-aware-readiness.md): reported-status and reachability are separate claims, and the fleet currently only makes the first. | ☐ |
| 9 | Tests: a saved address that is no longer local is replaced; `AGENT_URL` still wins; a Docker-internal address is not preferred over a LAN one; a re-register from a new address updates rather than duplicates; a colliding identity is reported. | ☑ |
| 10 | **Clean up the entry that is already wrong.** `mcpserver.local` is registered at `.242` today. The fix must either migrate it or make removing it possible without hand-editing persisted state. | ☐ |

## What was built (2026-09-13)

### Sidecar — `sideCar/src/lib/agent-address.ts` (new, pure, imports nothing)

Holds every decision; takes the interface map, env and port as arguments so the
rules are testable without a host to run on.

- `resolveAgentUrl` — `AGENT_URL` → `EXTERNAL_IP` → `savedAgentUrl` → detection →
  `127.0.0.1`. Only the `EXTERNAL_IP` inversion is fixed; detection stays below the
  persisted value because of the VPN case, so **no host's advertised address changes
  in this release** unless `EXTERNAL_IP` was being wrongly overridden.
- `detectAdvertisableAddress` — preserves the exact `172.17.`/`172.18.` demotion
  (item 4; deliberately **not** widened to 172.16/12, which would demote a real
  LAN on 172.20.x), and prefers a non-bridge address on the master's `/24` over
  "whichever the OS listed first" (the multi-homed risk).
- `advertisedHostLocality`, `AddressStabilityTracker`, `shouldReadvertise` —
  **built and tested, but NOTHING CALLS THEM.** They are the building blocks for a
  later release once the probe path exists. Kept because the logic is correct and
  the tests document it; dead by design, not by oversight.

### Sidecar — `ws-client.ts`

- `getAgentUrl()` delegates to `resolveAgentUrl` and **caches**. It is called on
  every heartbeat via `buildFullStatus()`, so re-resolving there would let a
  multi-homed host flap several times a minute.
- `initAgentAddress()` and `revalidateAgentUrl()` exist but are **not called from
  anywhere.** Both replace the persisted address with a detected one, which is the
  fleet-outage path described in the reframing. The two call sites that existed in
  the first draft — `startGossipClient()` and the 30 s `startWatchdog()` tick — were
  removed, and a comment at each site records why.
- `reregisterOnLiveSockets()` — re-registers on the **live** socket rather than
  forcing a reconnect, which is what makes the master's re-key decision
  unambiguous. Also currently reachable only via `revalidateAgentUrl()`.
- `self-update.ts:185` keeps its write; a comment records that it was the sole
  writer of the pin and how the loop perpetuated itself.
- `handlers.ts:48` `getPrimaryIp()` now shares `detectAdvertisableAddress()` instead
  of its own scan, so `/api/status` cannot report a different address than the
  advertiser would pick.

### Master — `src/lib/gpu/ws-relay.ts` — the observed peer address

- `wss.on('connection', (ws, req) => …)` — the second argument was always there and
  unused. `observedFromIp` now records `normalizePeerAddress(req.socket.remoteAddress)`
  on the connection entry, carried through `persistSidecarList()` as
  `lastSeenFromIp` (the field the HTTP register path already writes) and exposed on
  `getConnectedSidecars()`.
- `normalizePeerAddress()` strips `::ffff:` from IPv4-mapped IPv6.
- Registration logs `agentUrl`, `observedFromIp` and `declaredMatchesObserved`
  together, so a declared/observed disagreement is visible in the fleet's own logs.
- **Recorded, not routed on.** Switching the data path to it needs probe-and-
  fallback over candidates, and `resolveEndpoint` lives in `fleet-router.ts` —
  outside this task's file territory. Recording it now makes real evidence from the
  live fleet available to whoever builds that.

### Master — `src/lib/gpu/ws-relay.ts` — the re-key (item 5a)

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
entry.

Scope honestly stated: this clears the **master's** view. It does not un-pin a
running sidecar, which will re-advertise its persisted address once the 60 s block
expires — see the corrected REFUTED 3. Pair it with `AGENT_URL` / `EXTERNAL_IP` on
the host to make the correction stick.

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
  "escapes the loopback dead end once a real interface comes up" — a test over a
  path that, after the reframing, nothing calls automatically.
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

### Item 6 — decided: the socket is the identity; hostname is out; defer the id

**`hostname` is ruled out by the user's decision, and the VPN case adds a reason
beyond the collisions already in the table:** a name that resolves on one network
path and not another (`.local` over a VPN) fails *as if the host were down*, which
is strictly worse than a wrong address. `getDisplayHostname()`
(`sideCar/src/lib/ws-client.ts:~72-84`) stays purely cosmetic — nothing routes or
keys on it, and it is not removed, because it is what makes the fleet UI readable.

**Decision: for the duration of a connection, the socket *is* the identity.** That
is not a fallback — it is a stronger claim than any declared value, because it
cannot be spoofed, cloned or drift. It is what item 5a already exploits: a new
address on an already-registered socket is provably the same sidecar process, so
the registry key moves instead of duplicating. Combined with the observed peer
address, the master now learns both *who* (this socket) and *where* (the address it
connected from) without the sidecar declaring either.

**A durable generated id is deferred, and the observation is why.** Its only job
was to recognise a sidecar *across* connections — and with the peer address
observed, a reconnecting sidecar's correct address is known from the connection
itself, so a persistent id buys much less than it did when the sidecar's
declaration was the only source. It is also not a free win: a cloned VM carries its
source's id, so the collision path has to be real, not theoretical. Not worth the
wire-format change and master column until the probe-and-fallback path exists and
can say what it would be used for.

**Standing collision rule (implemented, not theoretical):** one address claimed by
a *different* live socket is **refused** — `logger.error` naming both hostnames, an
`{ok:false, error:'address-conflict: …'}` ack to the challenger, and **neither entry
replaced**. Proven by "two sidecars claiming one address names the conflict and
replaces neither entry". Any future identity scheme inherits this shape.

For the record, the options that were weighed before the observation made them
less necessary:

| Option | Durable across | Breaks on |
|---|---|---|
| **A. uuid in `config.json`** | restart, DHCP move, `docker rm` | config reset / volume GC; **VM or image clone → two hosts share one id** |
| **B. uuid + machine fingerprint** (`/etc/machine-id`, Docker host id) | as A, and a clone differs if the fingerprint does | fingerprint unavailable in some containers; `machine-id` is itself cloned by naive VM copies |
| **C. operator-assigned name** in `/admin/hostprov` | anything — declared, not derived | needs an action per host; a typo collides, though at assignment time where it can be caught |


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
