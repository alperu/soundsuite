# A config-push rekey clobbers a master slot, and the sidecar reconnects in a loop

**Status:** Proposed · **Effort:** M · **Priority:** **P0** — observed live, ~1 s cycle
**Created:** 2026-09-13
**Evidence:** sidecar log, 2026-09-13T17:48 (see below)
**Interacts with:** [task 41](./41-sidecar-address-drift.md) (address resolution) ·
[task 40](./40-fleet-admission-control.md) · the WS identity guards in
`src/lib/gpu/ws-relay.ts` and `sideCar/src/lib/ws-client.ts`

Field names and code citations only. No case data. Addresses below are as they
appeared in an operator-supplied log; **do not copy them into `sideCar/`**, which
is published publicly.

## What was observed

A repeating ~1 second cycle, with nothing failing:

```
WS command received: /config
Executing command: config
Config saved ... (masters=3, ..., agentUrl=http://<lan-a>:8098)
WebSocket disconnected
WS reconnect in 1s...
connectMaster: attempting (currentMode=disconnected, reconnectDelay=2000ms)
WebSocket connected
Registration acknowledged by server
WS command received: /config          <-- and round again
Config saved ... (masters=2, ..., agentUrl=null)
WebSocket disconnected
```

Two things to notice. **The disconnect always follows the `/config` push**, and
**the master count drops from 3 to 2** across one push. Nothing logs an error.

Separately, and probably unrelated to the loop, a third master is unreachable and
retried indefinitely:

```
HTTP heartbeat failed (53x): connect ECONNREFUSED <lan-c>:3000
HTTP heartbeat failed (54x): timeout
```

The operator states that master is not wanted.

## Verified in source before writing

### `rekeyMaster` overwrites an occupied slot

`sideCar/src/lib/state.ts:797-806`:

```ts
export function rekeyMaster(oldUrl: string, newUrl: string) {
  const m = state.masters.get(oldUrl);
  if (!m) return undefined;
  if (oldUrl === newUrl) return m;
  state.masters.delete(oldUrl);
  m.serverUrl = newUrl;
  state.masters.set(newUrl, m);      // <-- no check that newUrl is free
  ...
}
```

`set(newUrl, m)` silently replaces whatever `MasterConnection` already occupied
`newUrl`. That object is not closed and its timers are not cleared — it keeps a
live `ws`, a live `heartbeatTimer`, and a live reconnect chain, while nothing in
`state.masters` references it any more. **Map size falls by one, which matches
`masters=3 → masters=2` exactly.**

It is reached from the `config` command handler (`ws-client.ts:369-373`) whenever
a master pushes a `serverUrl` different from the slot's current key.

### This is the third instance of one defect class

The same shape has now been found and fixed twice in the last day:

| Where | The mistake |
|---|---|
| `src/lib/gpu/ws-relay.ts` | registry `set()` on re-register dropped the old socket without closing it |
| `sideCar/src/lib/ws-client.ts` `close` handler | tore down shared state without checking the state still referred to *that* socket |
| **`state.ts:797-806` `rekeyMaster`** | **replaces a map entry without closing or reconciling the entry it replaces** |

**Replacing an entry in a map of live connections is never just a `set`.** That
sentence belongs in the sidecar's design rules.

### Why it loops rather than settling

Unconfirmed — item 2 must establish the exact edge. The shape suggested by the
log: push arrives → rekey collides → the clobbered connection is orphaned but its
socket and timers keep running → a close fires on the orphaned object → its
handler mutates a `MasterConnection` no longer in the map and schedules a
reconnect → reconnect re-registers → master pushes `/config` again → repeat.

`scheduleReconnect` (`ws-client.ts:1204+`) never stops: backoff doubles to a
5-minute ceiling and retries forever by design.

## Why P0

- The master–sidecar link never stays up long enough to be useful, so acquire and
  release traffic races a connection that is about to drop.
- Each cycle is a register on the master, which exercises the supersede path
  roughly once per second on every affected host.
- `agentUrl` flipping to `null` mid-cycle means task 41's re-detection is running
  against a moving target.
- The churn is **silent**: every line in the log is `INFO`, and nothing reports a
  slot being lost.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building.** Re-verify `state.ts:797-806`, the `config` case at `ws-client.ts:365-373`, and that `masters=3 → 2` is the collision and not an unrelated prune. Check whether `addMaster`/`removeMaster` (`state.ts:785,792`) have the same unguarded shape. | ☐ |
| 2 | **Establish the exact loop.** Reproduce with two configured masters where one pushes a `serverUrl` equal to the other's key. Prove which close fires, on which object, and what schedules the next reconnect. **Do not fix a loop you have not reproduced** — the mechanism above is inferred from a log. | ☐ |
| 3 | **Make `rekeyMaster` total.** A destination that is already occupied is a *conflict*, not a silent overwrite. Decide and document: refuse, or merge and close the loser's socket and timers. Refusing with a named error is probably right — the sidecar cannot know which slot the operator meant. | ☐ |
| 4 | **Never orphan a connection.** Any path that removes a `MasterConnection` from the map must close its `ws` and clear `heartbeatTimer`, `pollTimer` and `wsReconnectTimer`. `disconnectMaster` (`ws-client.ts:1372`) already does exactly this — the bug is that rekey does not call it. | ☐ |
| 5 | **Guard the close handler on identity**, as `ws-client.ts` already does for superseded sockets: a close on an orphaned `MasterConnection` must not schedule a reconnect for a slot that no longer exists. | ☐ |
| 6 | **Give up on a master that cannot be reached** — or make giving up possible. Today `scheduleReconnect` retries forever. At minimum: after N consecutive failures, mark the master `unreachable` in `/status` and stop logging at ERROR every cycle, so a dead entry is visible as dead rather than as noise. Removing it must not require editing config inside a container. | ☐ |
| 7 | **Let an operator remove a master from the sidecar UI**, and make removal stick — the master must not re-add itself on the next push. Relates to the block-list already in `ws-relay.ts`. | ☐ |
| 8 | **Log a lost slot at WARN with both URLs.** The whole incident was INFO-level. A master count that changes without an operator action is not routine. | ☐ |
| 9 | Tests: a rekey onto an occupied slot does not reduce the master count silently; the loser's socket and timers are closed; a close on an orphaned connection schedules nothing; an unreachable master is reported rather than retried invisibly. | ☐ |

## Risks

- **Refusing a rekey can strand a legitimately renamed master.** If a master
  genuinely moves to a URL another slot holds, refusing leaves the operator stuck.
  Whatever item 3 chooses must leave a visible, actionable state — not a silent
  half-move.
- **Stopping reconnects can strand a master that is merely rebooting.** Item 6
  must distinguish "not answering right now" from "gone". Prefer reporting
  unreachable while still retrying slowly over giving up permanently.
- **`syncLegacyServerUrl()` runs inside rekey.** Changing rekey changes which URL
  legacy single-master surfaces (self-update, env bootstrap echo) resolve to.
  Check `legacyServerUrl()` consumers before altering ordering.
- **Shared config fields.** The `config` handler's own comment notes that
  `idleTimeouts`, `minOnline` and `registry` still mutate global state rather than
  per-master state ("v1 limitation"). A second master can therefore overwrite the
  first's settings. Out of scope here, but record it — it is a related bug.

## Acceptance

| Check | Expected |
|---|---|
| A master pushes a `serverUrl` already held by another slot | a named conflict, logged at WARN; no silent count change |
| Any master removed from the map | its socket closed and all three timers cleared |
| A config push on a healthy fleet | connection stays up; no reconnect |
| A master that refuses connections | reported `unreachable` in `/status`, not an ERROR every cycle |
| An operator removing a master | it stays removed |

## Note on the comparison

The operator reports the Fantom MCP master as more stable than this one against
the same sidecar. That is consistent with what was read from that implementation
earlier: it guards its close and error handlers on socket identity, runs a
ping/pong liveness sweep, and marks superseded sockets for a grace period instead
of closing them immediately. Since the sidecar client is shared, a stability
difference between two masters is evidence about the **masters**, not the sidecar —
worth using as a reference implementation rather than re-deriving.

## References

- `sideCar/src/lib/state.ts:785` (`addMaster`), `:792` (`removeMaster`), `:797-806` (`rekeyMaster`)
- `sideCar/src/lib/ws-client.ts:365-373` (config-push rekey), `:1204+` (`scheduleReconnect`), `:1372` (`disconnectMaster`)
- `sideCar/src/lib/ws-client.ts:14` — "config-push from any master mutates ... SHARED" (the v1 limitation)
- `src/lib/gpu/ws-relay.ts` — master-side supersede and identity guards, for reference
