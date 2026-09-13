# One master, one socket — remove the orphan instead of cleaning up after it

**Status:** Implemented (both parts) · **Effort:** S · **Priority:** **P0** — fixed a live fleet-wide loop
**Created:** 2026-09-13
**Diagnosis:** [`../MCP-Improvements/REPORT-v17-master-socket-obligations.md`](../MCP-Improvements/REPORT-v17-master-socket-obligations.md)
**Supersedes the loop chased through:** [task 42](./42-sidecar-master-slot-churn.md) rounds 1–5

Addresses are generic. No case data. `sideCar/` is published publicly.

## The defect, in one place

`sideCar/src/lib/ws-client.ts` `connectMaster()` checked **only `m.retired`**. No
check on `m.ws?.readyState`. So any caller opened a second socket, and the `open`
handler's `m.ws = ws` discarded the only reference to the first.

That orphan could be closed by **nobody but the master** — the client no longer knew
it existed. Hence:

- masters grew a supersede-on-register close (a prosthesis, independently, in each
  implementation);
- closing it landed in the client's close handler and fed a **~1.1 s reconnect
  loop** (`wsReconnectDelay`'s 1000 ms floor);
- before any such close existed, one host accumulated **10,196 open sockets** until
  every `child_process.spawn` failed with `spawn EBADF`.

The controlled comparison that found it: two masters on one host, one sidecar, one
client codebase. Polling `/api/masters` at 3 Hz for 24 s — Sound Suite flapped every
~1.1 s; the Fantom MCP server never changed state once. Fantom *marks* superseded
sockets and sweeps after a grace; Sound Suite closed immediately.

## Part A — client: refuse the second socket (`sideCar/src/lib/ws-client.ts`)

```ts
if (m.ws && (m.ws.readyState === WebSocket.OPEN ||
             m.ws.readyState === WebSocket.CONNECTING)) return;
```

`CONNECTING` counts: `connectAllMasters()` starts every slot in one tick, so an
`OPEN`-only test lets two attempts through before either completes its handshake —
exactly the boot case.

With this there is no orphan, nothing to supersede, and **no master needs a
prosthesis**. This is the root fix.

## Part B — master: mark superseded sockets, don't close them (`src/lib/gpu/ws-relay.ts`)

`SUPERSEDED_GRACE_MS` (default **45 s**, env `GPU_WS_SUPERSEDED_GRACE_MS`, `0`
restores immediate close). On re-register the incumbent is stamped
`SUPERSEDED_AT`; the existing 30 s liveness sweep terminates anything stamped
longer ago than the grace.

**Reaped on time, not on liveness.** An orphan the client stopped referencing still
answers pings — the `ws` library replies at protocol level — so the pong check can
*never* reclaim it. This is why "drop the reference and let the liveness sweep get
it" does not work, and why the grace must terminate unconditionally.

**Part B is not a stopgap and should not be removed once Part A ships.** A master
faces clients it cannot upgrade: older sidecars persist on a fleet for a long time,
and the sidecar is now published under PSSL, so third-party clients are real.
Tolerating a client that reconnects too often is the correct posture at a trust
boundary. Part A makes the fleet correct; Part B keeps the master robust.

Grace deliberately shorter than Fantom's 2 minutes: it chose that with the cause
unknown, and at observed churn it holds ~300 descriptors per host. The sweep runs
every 30 s regardless, so the damping is identical and the held count is an order of
magnitude lower.

## Why "reject the newcomer, keep the incumbent" was rejected

The intuitive fix — never kill a working channel, refuse the redundant register —
**cannot work in this protocol.** By the time the master sees the second register the
client has already overwritten `m.ws`; the new socket *is* its connection. Closing
it fires the close handler on the socket the client believes is live, the identity
guard does not apply (`m.ws === ws`), and it reconnects: the same loop with the roles
swapped. Recorded so nobody re-derives it.

## Work

| # | Item | Status |
|---|---|---|
| 1 | Client guard in `connectMaster`, including `CONNECTING`. | ☑ |
| 2 | Master marks instead of closes; sweep reaps after the grace. | ☑ |
| 3 | Grace env-tunable, `0` = immediate, so the old behaviour stays testable. | ☑ |
| 4 | Tests that fail without each fix — verified by neutering each guard. | ☑ |
| 5 | A test that the client guard does **not** wedge a slot shut after a genuine close. | ☑ |
| 6 | Update the three tests that asserted the *immediate-close mechanism* rather than the no-leak *property*. | ☑ |
| 7 | **Reset `wsReconnectDelay` on the first heartbeat, not on socket open.** Today a socket that opens and dies in 200 ms resets the backoff as though healthy, so it can never escalate out of a fast loop. **Deliberately deferred** — a third simultaneous change to this hot path during a live incident is not worth the risk, and with items 1–2 the loop should not start. | ☐ |
| 8 | `Enforce min-online` re-acquires three roles on **every register** — a socket event treated as a lifecycle event. Key it off the host, not the connection. | ☐ |

## Risks

- **Part B holds more descriptors than before.** Bounded by `grace × register rate`;
  at 45 s and a healthy fleet that is a handful. If churn returns, the count rises —
  so it is worth watching rather than assuming.
- **Part A could wedge a slot if the readyState test were wrong.** Covered by item 5:
  a genuine close must still reconnect. That test passes with and without the guard.
- **Part A needs a sidecar release**; Part B needs only a master restart. They can
  ship independently and in either order — neither depends on the other.

## Acceptance

| Check | Expected |
|---|---|
| 3 Hz poll of `/api/masters` for 60 s | the Sound Suite slot prints **no** transitions |
| `Closing superseded sidecar socket` in the master log | **zero** occurrences |
| `Marked superseded sidecar socket for reaping` | only if a client still re-registers |
| A genuine disconnect | the sidecar reconnects normally |
| Descriptors on the relay port | stable, not growing |

## References

- `sideCar/src/lib/ws-client.ts` — `connectMaster()` guard
- `src/lib/gpu/ws-relay.ts` — `SUPERSEDED_GRACE_MS`, `SUPERSEDED_AT`, `runLivenessSweep()`
- `src/lib/gpu/__tests__/ws-relay-socket-leak.test.ts` — master-side grace tests
- `src/lib/gpu/__tests__/sidecar-master-rekey.test.ts` — `one master, one socket`
- `mcpfantom/src/sidecars/soundsuiteMaster.ts:229-237,387-389` — the same pattern, independently
