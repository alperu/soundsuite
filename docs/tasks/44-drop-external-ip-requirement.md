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

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building.** Re-verify `ws-relay.ts:341` and `:248` still record and persist the observed address, that nothing reads it for routing, and that `resolveEndpoint` in `src/lib/gpu/fleet-router.ts` uses only the advertised `agentUrl`. Confirm `normalizePeerAddress` handles IPv6-mapped IPv4 (`::ffff:192.0.2.1`). | ☐ |
| 2 | **Decide the port.** The observed *source* port is ephemeral and useless. The callback port must come from the sidecar's declared `AGENT_PORT`/`PORT`, which it already sends. Make that explicit rather than assuming 8098. | ☐ |
| 3 | **Probe, then prefer.** `resolveEndpoint` should try the advertised address, and on failure fall back to the observed one — or probe both once and cache which answered. **Whichever order is chosen, a candidate is only used after it answered**, and the result is cached so this is not a per-request probe. | ☐ |
| 4 | **Have the sidecar advertise candidates, not one address.** It knows its bridge address, any pinned value, and anything else on its interfaces. Sending a list lets the master choose instead of guess. Additive to the register payload; the master must tolerate an older sidecar that sends only `agentUrl`. | ☐ |
| 5 | **Report which candidate is in use, and why.** `/status` and the admin pages should show the address the master is actually calling and its basis — pinned / advertised / observed. Without this the fallback is invisible and the next stale-address incident is debugged from scratch. Relates to [task 43](./43-admin-address-reconcile.md) item 6. | ☐ |
| 6 | **Make `EXTERNAL_IP` unnecessary, then say so.** Update `sideCar/README.md` and `docs/CONFIGURATION.md`: still honoured, no longer required, and state the one case where it is still needed (the master cannot reach the host at the address it saw the connection from). | ☐ |
| 7 | **Do not remove `EXTERNAL_IP` handling**, and do not warn about its presence. A pinned value is a legitimate operator choice, not a mistake. | ☐ |
| 8 | Tests: an unset `EXTERNAL_IP` with an unreachable bridge address still yields a working endpoint; a set `AGENT_URL` is never overridden; an advertised address that answers is preferred over an observed one; an IPv6-mapped peer normalises; an older sidecar sending only `agentUrl` still works. | ☐ |

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
