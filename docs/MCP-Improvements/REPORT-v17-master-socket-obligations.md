# MCP Report v17 — socket lifetime between a master and a sidecar

**Created:** 2026-09-13 · **Status:** diagnosis complete, fix not yet implemented
**Audience:** anyone implementing a Sound Suite master — including the **Fantom MCP
server** (`mcpfantom/src/sidecars/soundsuiteMaster.ts`), which implements the same
protocol independently and shares the same sidecar client.
**Origin:** a fleet-wide reconnect loop that survived three sidecar releases and a
rollback.

Addresses are generic (RFC 5737 / placeholders). No case data.

---

## The one-paragraph version

A sidecar's `connectMaster()` opens a new WebSocket **without checking whether it
already has a live one**, and assigns `m.ws = newSocket`, discarding its only
reference to the old socket. The old socket stays open, owned by nobody. The
**master** is therefore the only party that can close it — which is why Sound
Suite grew a "supersede on register" close, and why, before that close existed,
the master accumulated **10,196 open sockets from a single host** and every
`child_process.spawn` began failing with `spawn EBADF`.

So the master-side close is not the bug. It is a **prosthesis for a client that
leaks its own sockets.** Fixing it at the master is treating the symptom, and
every master implementation will independently grow the same prosthesis.

---

## The evidence, and why it is unusually clean

The fleet runs **two masters on one host**: Sound Suite on `:3000` (WS relay
`:3002`) and the Fantom MCP server on `:3848` (WS relay `:3003`). One sidecar, one
process, one client codebase, talking to both.

Polling the sidecar's `/api/masters` at 3 Hz for 24 s:

```
:3000 (Sound Suite)   websocket ↔ disconnected   every ~1.1 s, continuously
:3848 (Fantom)        no state change at all
```

That is a controlled experiment the system handed us for free: **identical client,
identical host, identical guard code — one master flaps, the other does not.** The
difference is entirely in what the master does with a superseded socket.

| | Sound Suite | Fantom |
|---|---|---|
| On re-register | **closes the previous socket immediately** | **marks** it superseded; a sweep terminates it after `SUPERSEDED_GRACE_MS` (2 min) |
| Observed result | 1.1 s flap loop | stable |

`~1.1 s` is not incidental: it is `wsReconnectDelay = 1000` plus connect time. The
client's reconnect floor sets the loop frequency.

Corroboration from the other direction: Fantom's own source records **221
reconnects / 90 s** with exactly one master entry per sidecar, and its comment says
the cause was unknown. That is the same loop, measured from the other end, before
the grace period was added to hide it.

---

## Root cause, in the client

`sideCar/src/lib/ws-client.ts`, `connectMaster()`:

```ts
export function connectMaster(m: MasterConnection): void {
  if (m.retired) { … return; }        // the ONLY early return
  m.wsEpoch = (m.wsEpoch ?? 0) + 1;   // epoch guards callbacks, not socket count
  …
  const ws = new WebSocket(wsUrl, { headers });
  ws.on('open', () => { … m.ws = ws; … });   // overwrites the old reference
}
```

There is **no check on `m.ws?.readyState`**. Consequences:

1. Anything that calls `connectMaster` on a slot that is already connected creates
   a **second live socket**.
2. `m.ws = ws` on open makes the previous socket **unreferenced**. The client can
   no longer close it — it does not know it exists.
3. `scheduleReconnect()` → `connectMaster()` runs on a 1 s floor, so any single
   spurious close becomes a sustained 1 Hz loop.
4. `wsReconnectDelay` is reset to `1000` on socket **open**, not on a *sustained*
   connection — so a socket that opens and dies in 200 ms resets the backoff as
   though it were healthy. **The backoff can never escalate out of a fast loop.**

The epoch mechanism protects *callbacks* from acting on behalf of a stale attempt.
It does not prevent a second socket from existing.

---

## Why "reject the newcomer, keep the incumbent" does NOT work here

This is the intuitive fix — never kill a working channel; refuse the redundant new
registration instead. **It is wrong for this protocol**, and the reasoning is worth
recording so nobody else spends a day on it.

By the time the master sees the second register, the client has **already
overwritten `m.ws`**. From the client's point of view the new socket *is* its
connection; the old one is forgotten. So:

- Reject and close the **new** socket → the client's close handler fires for the
  socket it believes is live, its identity guard does not apply (`m.ws === ws`), it
  nulls `m.ws` and schedules a reconnect. **The same loop, with the roles swapped.**
- Drop the reference without closing anything → the orphan stays open. A liveness
  sweep cannot reap it, because **an orphaned-but-alive socket still answers
  pings** (`ws` responds to ping at protocol level automatically). The sweep catches
  *dead peers*, not *surplus live ones*. The FD leak returns in its original form.

There is no master-side policy that fixes this, because the resource is leaked by
the client and only the client knows which socket it intends to keep.

---

## Fix order — client first

**1. (Client, required) One master, one socket — enforced where sockets are made.**

```ts
if (m.ws && (m.ws.readyState === WebSocket.OPEN ||
             m.ws.readyState === WebSocket.CONNECTING)) {
  log.debug(`[${m.serverUrl}] connectMaster: socket already live — not opening a second`);
  return;
}
```

With this, no redundant socket is ever created, no orphan exists, and **no master
needs to close a live socket at all.** Every master implementation stops needing
its own prosthesis.

**2. (Client) Reset backoff on a sustained connection, not on open.** Move the
`wsReconnectDelay = 1000` reset to the first successful heartbeat. A socket that
dies before it heartbeats then escalates like any other failure.

**3. (Master) Keep the close, narrow its justification.** Once (1) ships, a second
register on a live connection is a **client protocol violation**, not routine. Close
is then defensible on technical grounds — but log it at WARN, because after (1) it
should never happen, and its appearance means a client regressed.

**4. (Master) Do not treat a new socket as a new relationship.** Sound Suite runs
`Enforce min-online` and re-`/acquire`s three roles on **every** register. At 1 Hz
that is continuous container churn driven purely by transport events. Key that work
off the **host**, not off the connection.

---

## Obligations checklist for a master implementation

For the Fantom MCP server and any future master. Derived from defects that actually
shipped.

| # | Obligation | Why |
|---|---|---|
| 1 | **Never close a functioning socket for a bookkeeping reason.** Closes must be technical (no pong, handshake not completed, protocol violation) or explicitly operator-initiated. | A policy close lands in the client's close handler and is indistinguishable from a network failure. |
| 2 | **Add ping/pong liveness with a terminate-on-no-pong sweep.** `close` fires only on a TCP FIN; a host that loses power or a dropped VPN sends nothing and the socket stays `ESTABLISHED` indefinitely. | This is the only close that reliably bounds descriptors. |
| 3 | **Bound the register handshake.** Close a socket that connects and never registers. It belongs to nobody, and it answers pings, so the liveness sweep will spare it forever. | Observed: more open sockets than registered sidecars. |
| 4 | **Guard every close handler on socket identity.** Before tearing down shared state, check the state still refers to *that* socket. | Closing a superseded socket otherwise destroys the live one — a self-sustaining loop. |
| 5 | **Never replace an entry in a map of live connections with a bare `set()`.** Close or reconcile what you displace. | Found five times in this codebase in two days. |
| 6 | **Do not create a slot/registry entry from an advisory signal.** A URL in a response header, a discovery probe, or an identity announcement must not manufacture a second identity for a peer you are already talking to. | `X-Sound-Suite-Master-Url` did exactly this on *every* reply and produced a permanent duplicate. |
| 7 | **Identify a peer by something stable, not by URL string.** A multi-homed peer reachable on a LAN address and a VPN address becomes two identities under URL keying. | URL-keyed slots defeat every same-endpoint guard. |
| 8 | **A socket event is not a lifecycle event.** Re-registration means "new pipe to the same peer", not "new peer" — do not re-provision, re-acquire, or reset counters on it. | `min-online` re-acquired three roles per register. |
| 9 | **Make degraded states self-describing.** `mode: websocket` with `lastHeartbeat: never` and `consecutiveFailures: 0` were all three *accurate* and jointly useless. | The 5 s heartbeat timer was reset by each new socket, so it never fired once. Send one heartbeat immediately on register. |

---

## How to verify a fix — the loop that found this

Log inspection repeatedly produced plausible-but-wrong conclusions here. What
settled it was a 3 Hz poll of the sidecar's own `/api/masters`, printing only
**state transitions**:

```python
prev = {}
while time.time() - t0 < 24:
    for m in json.load(urllib.request.urlopen(f"{SIDECAR}/api/masters")):
        key = m["serverUrl"][-5:]
        sig = (m["connectionMode"], m.get("wsReconnectDelay"), m.get("connectionStatus"))
        if prev.get(key) != sig:
            print(f"{time.time()-t0:5.1f} {key} {sig}")
            prev[key] = sig
    time.sleep(0.3)
```

A healthy slot prints **two lines and then nothing**. A flapping slot prints a pair
every cycle. With two masters configured, it is a built-in A/B test: the stable one
is the control.

Acceptance for the fix in (1): `:3000` prints nothing for 60 s, and the master's
`Closing superseded sidecar socket` count over the same window is **zero**.

---

## What made this hard to find, worth recording

Five diagnoses preceded the correct one. Each identified a **real defect** — a
duplicate-slot generator, a silent clobber, an orphan reconnecting forever, a
defaulted WS port colliding on a shared host — and each was **wrong about the live
incident**. One release made it worse; a rollback changed nothing, which was the
single most informative result of the day, because it eliminated every sidecar-side
theory at once.

The reason is structural: the loop is a **two-party interaction**, and both parties'
logs describe only their own half. The master logs "I closed a superseded socket"
and the sidecar logs "my socket disconnected"; neither records *who initiated*.
Until a signal existed that showed one party's state machine over time, every
theory was consistent with the evidence.

**The lesson to carry:** when two components each behave correctly in isolation,
instrument the *relationship*, not the components.

---

## References

- `sideCar/src/lib/ws-client.ts` — `connectMaster()` (no live-socket guard), the
  `open` handler's `m.ws = ws`, `scheduleReconnect()`, `wsReconnectDelay`
- `src/lib/gpu/ws-relay.ts` — supersede-on-register, the liveness sweep, the
  register-handshake timeout
- `src/lib/gpu/fleet-router.ts` — `Enforce min-online` on the register path
- `mcpfantom/src/sidecars/soundsuiteMaster.ts` — independent master; the
  `SUPERSEDED_GRACE_MS` comment records the same loop from the other side
- [`../tasks/42-sidecar-master-slot-churn.md`](../tasks/42-sidecar-master-slot-churn.md)
  — rounds 1–5, including the four diagnoses that were right about a defect and
  wrong about the incident
