# `EXTERNAL_IP` should be optional — the master already observes the address it needs

**Status:** Proposed · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-13
**Goal, in the operator's words:** *"Can I have it so I don't add an EXTERNAL_IP
variable."*
**Depends on:** [task 41](./41-sidecar-address-drift.md) — the observation it needs
is already recorded there, but nothing routes on it.
**Interacts with:** [task 42](./42-sidecar-master-slot-churn.md) ·
[task 43](./43-admin-address-reconcile.md)

Field names and code citations only. No case data. `sideCar/` is published
publicly — use RFC 5737 (`192.0.2.x`) addresses in anything under it.

## Why `EXTERNAL_IP` is mandatory today, and why that is the real defect

A containerised sidecar reports `ip: "172.17.0.2"` — the Docker bridge. That is
**the only address `os.networkInterfaces()` can see from inside the container.**
The host's LAN address is not visible there at all, and `host.docker.internal`
resolves to the Docker gateway, not to the host's LAN interface.

So on-host detection cannot work for a containerised sidecar, in principle, not as
a bug to be fixed. `EXTERNAL_IP` exists to paper over that — and it is a hand-copied
constant that goes stale the moment DHCP moves the host, with no way to notice:
restarting cannot help, because env lives in the container's config rather than in
`/app/config`. Recreating the container is the only cure.

**This is a defect of the design, not of the operator's configuration.** A value
that must be typed by hand, cannot be validated, and silently breaks routing when
the network changes should not be required.

### The master already knows the answer

The sidecar connects **outbound** to the master. The master therefore sees the
address the sidecar reached it *from*, and that address is the host's — the
container NATs out through it. Recorded already, from task 41:

- `src/lib/gpu/ws-relay.ts:341` — `normalizePeerAddress(req?.socket?.remoteAddress)`
  captured as `observedFromIp` (the `req` argument to `wss.on('connection')` was
  always available and unused).
- `:248` — persisted as `lastSeenFromIp`.

**It is recorded and nothing uses it.** Closing that gap removes the need for
`EXTERNAL_IP` in the common case, and does so with information the master
collected itself rather than information an operator promised.

It is also strictly better than any sidecar-side detection for the VPN case: which
address is correct depends on which network the **master** is on, and only the
master knows that.

## What must not be broken

- **`AGENT_URL` and `EXTERNAL_IP` must still win when set.** An operator pins them
  deliberately for NAT, proxies and multi-homed hosts. This task makes them
  *optional*, never ignored.
- **The observed address is only usable if the sidecar's port is reachable at it.**
  It holds for the documented run (`-p 8098:8098` publishes on the host), and fails
  behind NAT, a one-way tunnel, or a proxy that rewrites the peer. So the master
  must **probe, not assume** — see item 3.
- **Do not route on an unprobed address.** Substituting an observed address for a
  working advertised one, without checking, would trade a stale-address bug for an
  unreachable-address bug. That is this repo's recurring defect: acting on a claim
  nothing verified.

## Verification pass (2026-09-13, item 1) — read from source

**Held:** `ws-relay.ts:341` still captures `normalizePeerAddress(req?.socket?.remoteAddress)`
· `:248` still persists it as `lastSeenFromIp` · `normalizePeerAddress` (`:128`)
strips `::ffff:` and is covered by a task 41 test · `resolveEndpoint` derived both
return values purely from the advertised `sidecar.url`, at three sites
(`:1309`, `:1362`, `:1389` pre-edit).

### REFUTED — "nothing reads it" is false

`src/lib/gpu/sidecar-reconnect-watchdog.ts:96-97` **already** falls back to
`lastSeenFromIp`:

```ts
if (entry.lastSeenFromIp) {
  return `http://${entry.lastSeenFromIp}:${DEFAULT_SIDECAR_ADMIN_PORT}`;
```

Nothing reads it *for role routing*, which is the gap this task closes — but the
design is not unprecedented. And note what that prior art does wrong: it
**hardcodes the port**, which is precisely the trap item 2 warns about. A sidecar
on a non-default `AGENT_PORT` gets an unreachable URL from that path. Recorded, not
fixed — it is the reconnect/admin path, not this one.

### REFUTED — the persisted shape is declared four times, and fleet-router's was missing the field

`SidecarEntry` in `fleet-router.ts:259` had **no** `lastSeenFromIp`, while three
other local declarations of the same persisted `gpu.sidecars` shape do
(`sidecars/register/route.ts:18`, `sidecars/heartbeat/route.ts:22`,
`sidecar-reconnect-watchdog.ts:48`). The value was reaching `getFleetStatus()` at
runtime — `readSidecarList()` is a raw `JSON.parse` and `writeSidecarList()` a raw
`JSON.stringify`, so unknown fields survive round-trips and operator edits — but
TypeScript could not see it. Added to fleet-router's declaration. The four-way
duplication is pre-existing and not unified here.

### Pre-existing bug found, deliberately NOT fixed

`fleet-router.ts:547` (`testSidecar`) fetches `` `${normalized}/health` `` — with no
`/api` prefix, against a sidecar whose routes live under `/api`
(`sidecar-reconnect-watchdog.ts:121` gets this right). So its direct-HTTP check
**always fails** and `directOk` is permanently false. Fixing it would change
`testSidecar`'s behaviour for existing callers, so it is reported rather than
folded into a data-path change. This module does not copy the mistake.

### The probe target: `/api/health` is the wrong endpoint

`sideCar/src/app/api/health/route.ts` returns `{ ok: true, uptime }` — it
identifies **nothing**. Probing it would satisfy "answered 200" while failing the
exact risk this task names: a NAT device or proxy on port 8098 passes. So the probe
uses `/api/status` and requires a sidecar-shaped document (`agent.version` +
`mode` + `roles`), plus a `version` match against the heartbeat-cached value.

**`hostname` is deliberately NOT compared.** `/api/status` returns
`os.hostname()` (`handlers.ts`, the `handleStatus` return), while the status cache
holds `getDisplayHostname()` — which honours `SIDECAR_HOSTNAME`, the Docker host
name, or a `gpu-<n>` fallback for a hex container id. Those legitimately differ, so
comparing them would reject a healthy sidecar.

### Item 2 answers itself — no new plumbing

The callback port needs nothing new. Role endpoints already compute `resolvedPort`
via `portFor()`, and the sidecar admin port comes from `new URL(sidecar.url).port` —
the **declared** port, which the sidecar already sends. The observed *source* port is
ephemeral and is never used. Nothing hardcodes 8098; a test pins a `:9099` sidecar.

## What was built (master side only)

### `src/lib/gpu/sidecar-address-probe.ts` (new)

`resolveSidecarAddress()` decides which address to call, probing at most once per
60 s TTL per host, cached on `globalThis` (same reason `ws-relay`'s maps are: Next.js
re-evaluates modules per context). Order is deliberately conservative:

1. **advertised** — today's behaviour, and how an operator's `AGENT_URL` /
   `EXTERNAL_IP` pin arrives at the master. A pin that answers is never substituted.
2. **observed** — the peer address, only if the advertised one did not answer.
3. **`advertised-unverified`** — nothing answered: return the advertised address
   anyway. Never drop a host. On the embedding/rerank/RLM path, failing back to
   today's behaviour beats any clever substitution.

Loopback and `172.17.`/`172.18.` are never used as an observed target — they
describe the master's own side of the connection, not an address the fleet can reach.

### `src/lib/gpu/fleet-router.ts`

- `SidecarEntry.lastSeenFromIp` declared (see above).
- **One** `hostFor(sidecar)` helper, called at all three `resolveEndpoint` return
  paths. Three ragged edits on this function is how a regression gets in. It
  try/catches to the advertised hostname, so a fault in the probe layer cannot take
  the data path down.
- `FleetSidecar.effectiveAddress` — `{ baseUrl, basis, decidedAt }` or `null`,
  filled from `peekAddressChoice()`, which **never probes**. A fleet listing must not
  fire N reachability checks. This is item 5's data source.

## Item 4 — DEFERRED (needs `sideCar/**`, held by task 42)

Specified, not built. Additive to the register frame; a master must tolerate its
absence, which the code above already does (an older sidecar sending only `agentUrl`
is covered by a test).

```ts
{ type: 'register', agentUrl, hostname, containers,
  // NEW, optional:
  candidates: [
    { url: 'http://192.0.2.10:8098',  source: 'env:AGENT_URL' },
    { url: 'http://172.17.0.2:8098',  source: 'detected', iface: 'eth0' },
  ],
  advertisedPort: 8098 }
```

`source` reuses `AgentUrlSource` from `sideCar/src/lib/agent-address.ts`, which
already produces exactly these labels.

**Why item 4 is more than an optimisation.** Acceptance says "`AGENT_URL` set →
honoured exactly, never substituted". The master **cannot** implement that today: a
pin is indistinguishable from a detected address once it arrives as `agentUrl`.
Advertised-first guarantees a *working* pin is never substituted, but a pin that does
**not** answer currently does get a fallback attempt — which is better than an
outage, and is the deliberate reading of that row. Only `source` lets the master
honour a pin unconditionally. **Flagged for a ruling** rather than decided here.

## Item 5 — data available, UI not built (outside territory)

`effectiveAddress` is on every `FleetSidecar`, so `/api/admin/gpu-fleet` already
returns it — no route change needed. The remaining work is display, in
`src/app/admin/**` (held by task 43): show `basis` as a pill on the host row
(`pinned/advertised` · `observed` · `unverified`) and `baseUrl` as the address the
master is actually calling. Without it the fallback is invisible and the next
stale-address incident is debugged from scratch.

## Item 6 — wording for `sideCar/README.md` / `docs/CONFIGURATION.md` (outside territory)

To paste by whoever holds `sideCar/**`:

> **`EXTERNAL_IP` (optional).** The address the master should call this host on. You
> normally do **not** need to set it: the master records the address your sidecar
> connected to it from and falls back to that when the advertised address does not
> answer, so a containerised sidecar that can only see the Docker bridge is reached
> without any configuration, and keeps working when DHCP moves the host.
>
> Set it only when the master cannot reach the host at the address it saw the
> connection arrive from — behind NAT without a forwarded port, a one-way tunnel, or
> a proxy that rewrites the peer address. A value you set is always honoured and is
> never substituted while it answers.

## Work

Status legend: ☑ done · ◐ partial, remainder named · ☐ not built.

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building.** Re-verify `ws-relay.ts:341` and `:248` still record and persist the observed address, that nothing reads it for routing, and that `resolveEndpoint` in `src/lib/gpu/fleet-router.ts` uses only the advertised `agentUrl`. Confirm `normalizePeerAddress` handles IPv6-mapped IPv4 (`::ffff:192.0.2.1`). | ☑ |
| 2 | **Decide the port.** The observed *source* port is ephemeral and useless. The callback port must come from the sidecar's declared `AGENT_PORT`/`PORT`, which it already sends. Make that explicit rather than assuming 8098. | ☑ |
| 3 | **Probe, then prefer.** `resolveEndpoint` should try the advertised address, and on failure fall back to the observed one — or probe both once and cache which answered. **Whichever order is chosen, a candidate is only used after it answered**, and the result is cached so this is not a per-request probe. | ☑ |
| 4 | **Have the sidecar advertise candidates, not one address.** It knows its bridge address, any pinned value, and anything else on its interfaces. Sending a list lets the master choose instead of guess. Additive to the register payload; the master must tolerate an older sidecar that sends only `agentUrl`. | ☐ |
| 5 | **Report which candidate is in use, and why.** `/status` and the admin pages should show the address the master is actually calling and its basis — pinned / advertised / observed. Without this the fallback is invisible and the next stale-address incident is debugged from scratch. Relates to [task 43](./43-admin-address-reconcile.md) item 6. | ◐ |
| 6 | **Make `EXTERNAL_IP` unnecessary, then say so.** Update `sideCar/README.md` and `docs/CONFIGURATION.md`: still honoured, no longer required, and state the one case where it is still needed (the master cannot reach the host at the address it saw the connection from). | ☐ |
| 7 | **Do not remove `EXTERNAL_IP` handling**, and do not warn about its presence. A pinned value is a legitimate operator choice, not a mistake. | ☑ |
| 8 | Tests: an unset `EXTERNAL_IP` with an unreachable bridge address still yields a working endpoint; a set `AGENT_URL` is never overridden; an advertised address that answers is preferred over an observed one; an IPv6-mapped peer normalises; an older sidecar sending only `agentUrl` still works. | ☑ |

## Risks

- **A probe on the routing path costs latency.** Item 3 must cache the outcome, or
  every acquire pays a reachability check. Cache invalidation on re-register is the
  natural trigger.
- **The observed address can be a proxy or a NAT device**, which answers on port
  8098 as something else entirely. A probe must confirm it is *this sidecar* — hit
  an endpoint that identifies it, not merely one that returns 200.
- **Task 42's reconnect loop is live on at least one host.** If a sidecar
  re-registers once per second, any probe or cache write on the register path runs
  at that rate. Keep it idempotent and cheap.
- **`fleet-router.ts` is on the data path** for embeddings, rerank and RLM. A
  regression here is a fleet-wide outage, not a display bug. Prefer failing back to
  today's behaviour — use the advertised address — over any clever substitution.

## Acceptance

| Check | Expected |
|---|---|
| A containerised sidecar with **no** `EXTERNAL_IP` and no `AGENT_URL` | the master reaches it |
| The same host after DHCP moves it | still reached, with no operator action and no container recreation |
| `AGENT_URL` set | honoured exactly, never substituted |
| A sidecar reachable only via a pinned address (NAT) | still works with `EXTERNAL_IP` set |
| Any address the master is calling | its basis visible in `/status` and the admin pages |
| An older sidecar that sends only `agentUrl` | unaffected |

## References

- `src/lib/gpu/ws-relay.ts:128` (`normalizePeerAddress`), `:341` (capture), `:248` (persist)
- `src/lib/gpu/fleet-router.ts` — `resolveEndpoint`, the only consumer that matters
- `sideCar/src/lib/agent-address.ts` — `resolveAgentUrl` and its `source` field
- `sideCar/src/lib/ws-client.ts` — register payload, `AGENT_PORT`/`PORT`
- Observed live: a containerised sidecar reporting `ip: "172.17.0.2"` with
  `savedAgentUrl: null`, advertising only what `EXTERNAL_IP` gave it
