# A config-push rekey clobbers a master slot, and the sidecar reconnects in a loop

**Status:** Implemented (items 1-6, 8, 9) · **Effort:** M · **Priority:** **P0** — observed live, ~1 s cycle
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

### Why it loops rather than settling — REFUTED, and the real mechanism

The shape above was inferred from the log. **It is wrong.** Reproduced in
`src/lib/gpu/__tests__/sidecar-master-rekey.test.ts` (real `ws-client.ts` driven
against two fake `ws` servers, one of which mirrors the relay's
supersede-on-re-register at `src/lib/gpu/ws-relay.ts:418-421`):

- With the collision, and with the destination master closing the loser's socket:
  **no repeated re-registration.** 2 registrations, steady.
- With a single master that closes superseded sockets: **no loop.** 1 registration
  over 3 s.
- With **two slots keyed differently that dial the same ws endpoint**:
  **6 registrations in 5 s.** That is the loop.

The mechanism is *slot duplication*, not orphaning. The master identifies a
sidecar by **agentUrl**, so it permits one socket per sidecar — not one per slot.
Two slots for one master therefore each close the other's socket on register, and
each close schedules its own reconnect on the 1 s backoff. Forever.

Corroboration from the other side of the wire: `mcpfantom`'s
`src/sidecars/soundsuiteMaster.ts` (`SUPERSEDED_GRACE_MS`) records **221
reconnects / 90 s measured 2026-09-13 with exactly one Fantom master entry per
sidecar**, and concludes "root cause is on the client side and still unknown".
That measurement and this reproduction are the same defect, and the cause is now
known: the sidecar held more than one slot for one master. The master-side
`SUPERSEDED_GRACE_MS = 2 min` workaround can be revisited once fleets are on a
sidecar carrying this fix.

**The generator of the duplicate**, proven by test rather than inferred, was the
`master-identity` handler (`ws-client.ts`, then ~1237): it rekeyed the slot only
when the announced canonical URL differed by a **trailing slash**, and otherwise
called `ensureMaster(normalized)` — adding a *second slot for the master it was
already talking to*. A `master-identity` frame whose `canonicalUrl` differed by
more than a slash took `state.masters.size` from 1 to 2 in one frame.

`scheduleReconnect` never stops: backoff doubles to a 5-minute ceiling and retries
forever by design. That is correct behaviour for a rebooting master and is kept.

## Why P0

- The master–sidecar link never stays up long enough to be useful, so acquire and
  release traffic races a connection that is about to drop.
- Each cycle is a register on the master, which exercises the supersede path
  roughly once per second on every affected host.
- `agentUrl` flipping to `null` mid-cycle means task 41's re-detection is running
  against a moving target.
- The churn is **silent**: every line in the log is `INFO`, and nothing reports a
  slot being lost.

## What the verification pass found (item 1)

| Premise | Verdict |
|---|---|
| `rekeyMaster` overwrites an occupied slot, map shrinks by one | **CONFIRMED.** 2 → 1 in test. |
| The clobbered connection keeps a live `ws` | **CONFIRMED.** `readyState === OPEN`, referenced by nothing. |
| `addMaster`/`removeMaster` have the same unguarded shape | **PARTLY.** `ensureMaster` is idempotent and safe. `removeMaster` deleted the key without touching the connection — every caller had to remember `disconnectMaster` first, and `rekeyMaster` did not. Now warns loudly and `retireMaster()` is the supported path. |
| The loop is the orphan's close scheduling a reconnect | **REFUTED.** See above. The orphan *does* reconnect forever (proven), but that is a leak, not the 1 s cycle. |

Two defects the task doc did not cite, both found by the reproduction:

- **`scheduleReconnect`'s guard was a key check, not an identity check**:
  `if (!state.masters.has(m.serverUrl)) return`. An orphan whose key had been
  taken over by another `MasterConnection` passed that guard, so it reconnected
  and re-registered forever. Test: expected 1 registration, measured 2.
- **`disconnectMaster` re-armed the reconnect it had just cancelled.** It clears
  `wsReconnectTimer` and nulls `m.ws`, but `ws.close()` fires asynchronously, and
  by then `m.ws === null` — which is exactly the close handler's
  failed-handshake fall-through to `scheduleReconnect`. So item 4's hint ("the bug
  is that rekey does not call `disconnectMaster`") was **necessary but not
  sufficient**: calling it would have scheduled a reconnect for the slot being
  removed. Fixed with a per-connection epoch.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building.** Re-verify `state.ts:797-806`, the `config` case at `ws-client.ts:365-373`, and that `masters=3 → 2` is the collision and not an unrelated prune. Check whether `addMaster`/`removeMaster` (`state.ts:785,792`) have the same unguarded shape. | ☑ |
| 2 | **Establish the exact loop.** Reproduce with two configured masters where one pushes a `serverUrl` equal to the other's key. Prove which close fires, on which object, and what schedules the next reconnect. **Do not fix a loop you have not reproduced** — the mechanism above is inferred from a log. | ☑ **mechanism REFUTED; real one found** |
| 3 | **Make `rekeyMaster` total.** A destination that is already occupied is a *conflict*, not a silent overwrite. Decide and document: refuse, or merge and close the loser's socket and timers. Refusing with a named error is probably right — the sidecar cannot know which slot the operator meant. | ☑ refuses, `RekeyResult` |
| 4 | **Never orphan a connection.** Any path that removes a `MasterConnection` from the map must close its `ws` and clear `heartbeatTimer`, `pollTimer` and `wsReconnectTimer`. `disconnectMaster` (`ws-client.ts:1372`) already does exactly this — the bug is that rekey does not call it. | ☑ `retireMaster()` |
| 5 | **Guard the close handler on identity**, as `ws-client.ts` already does for superseded sockets: a close on an orphaned `MasterConnection` must not schedule a reconnect for a slot that no longer exists. | ☑ epoch + identity |
| 6 | **Give up on a master that cannot be reached** — or make giving up possible. Today `scheduleReconnect` retries forever. At minimum: after N consecutive failures, mark the master `unreachable` in `/status` and stop logging at ERROR every cycle, so a dead entry is visible as dead rather than as noise. Removing it must not require editing config inside a container. | ☑ reports `unreachable`, keeps retrying |
| 7 | **Let an operator remove a master from the sidecar UI**, and make removal stick — the master must not re-add itself on the next push. Relates to the block-list already in `ws-relay.ts`. | ☐ **NOT BUILT** — see below |
| 8 | **Log a lost slot at WARN with both URLs.** The whole incident was INFO-level. A master count that changes without an operator action is not routine. | ☑ |
| 9 | Tests: a rekey onto an occupied slot does not reduce the master count silently; the loser's socket and timers are closed; a close on an orphaned connection schedules nothing; an unreachable master is reported rather than retried invisibly. | ☑ 9 tests |

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


## What was built

All in `sideCar/src/` unless stated.

- **`state.ts` `rekeyMaster` is total.** Returns
  `{ok: true, master} | {ok: false, reason: 'not-found'} | {ok: false, reason: 'conflict', occupant}`.
  Nothing mutates on the refusal path — no `delete`, no `m.serverUrl` write, no
  `syncLegacyServerUrl()`, since a half-applied rekey is worse than the overwrite
  it replaces. This makes every caller agree with
  `api/masters/[serverUrl]` PATCH, which already answered **409** for the same
  collision.
- **`state.ts` `removeMaster` warns** when the slot it deletes still has a socket
  or any of the three timers. The whole incident was INFO-level (item 8).
- **`MasterConnection.wsEpoch`** — bumped by every `connectMaster` attempt and by
  `disconnectMaster`. The connect timeout and the `open`/`close`/`error` handlers
  capture their epoch and bail when it no longer matches. This is what the
  `m.ws !== ws` identity check could not cover: a manual disconnect (which nulls
  `m.ws` before the close event lands) and a retired slot.
- **`MasterConnection.retired`** + **`retireMaster()`** (`ws-client.ts`) — the only
  supported way to drop a slot: close the socket, clear all three timers, bump the
  epoch, mark retired, *then* remove the key. `api/masters/[serverUrl]` DELETE and
  `api/status` disconnect now use it.
- **`scheduleReconnect` checks identity, not the key**
  (`state.masters.get(m.serverUrl) !== m`) and retires the orphan it finds.
- **`master-identity` never adds a slot.** One master is one slot. A second slot
  for the announcing master is retired; a trailing-slash difference is rekeyed in
  place; a genuinely different announced URL is logged and **not adopted** — the
  key we are connected on demonstrably works and the announced one is unverified,
  and on a host whose master is sometimes behind a VPN a wrong address takes the
  host dark (see task 41 and the `startGossipClient` comment). The cost of that
  choice: a renamed master no longer self-heals its persisted key from an identity
  frame. That is deliberate.
- **`connectMaster` refuses a redundant socket.** Two slots that dial the *same*
  `ws://host:port/sidecar` are the same master process — a string comparison, not
  an inference about the network. The second slot logs a WARN naming the holder,
  sets `connectionStatus = "Duplicate of <url> — not connecting"`, and backs off
  to 60 s instead of ping-ponging at 1 s. This heals fleets whose **persisted
  config already contains duplicate slots**, which the generator fix alone cannot
  do.
- **Unreachable is reported, never given up on** (item 6). Past
  `UNREACHABLE_AFTER_DELAY_MS` (60 s backoff) or `UNREACHABLE_AFTER_FAILURES` (12
  consecutive HTTP heartbeat failures) a slot is marked `unreachable`, announced
  **once** at WARN, and its per-cycle failures drop to `debug`. It keeps retrying
  on the capped backoff, because a master that is merely rebooting must recover
  without operator action. Surfaced as `unreachable` and `consecutiveFailures` on
  every master in `/api/status` (`handlers.ts`) and `GET /api/masters`.
- **`disconnectMaster` stops process-wide update checks** when no WS master is
  left. Previously only the close handler did that, and the close handler now
  correctly returns early for a socket the teardown has invalidated. Without this
  the interval stayed armed (visible as Jest not exiting).

## What was deliberately NOT built

- **Item 7 — operator removal that survives a re-add.** `retireMaster` makes a
  removal stick against *reconnects*, but a later `ensureMaster(url)` (POST
  `/api/masters`, a `master-identity` frame, or a config reload) still creates a
  fresh slot. Making it stick needs a **persisted block-list**, mirroring the one
  in `src/lib/gpu/ws-relay.ts`, plus a `config.ts` field and UI. That is its own
  task, and the loop it was meant to stop is already stopped by the duplicate
  guard above.
- **A give-up path for an unreachable master.** The Risks section is right: that
  strands a rebooting master. Reporting plus slow retry is what shipped.

## Also found, not fixed (record only)

- **`config.ts` `loadSavedConfig` dedupes master entries by exact string.** It
  merges config.json + sidecar.config.json + `SIDECAR_MASTERS`, so an alias and a
  canonical name for one master both survive boot as separate slots. The
  `connectMaster` duplicate guard now neutralises the *symptom* at runtime, but
  the boot-time merge is a second way to grow duplicate slots and deserves its own
  look.
- The `config` handler's `idleTimeouts` / `minOnline` / `registry` still mutate
  **shared** state (the v1 limitation at `ws-client.ts:14`), so a second master
  overwrites the first's settings. Unchanged here.

## Tests

`src/lib/gpu/__tests__/sidecar-master-rekey.test.ts` — 10 tests, `@jest-environment
node`, driving the real `ws-client.ts` against fake `ws` servers. It does not touch
`src/lib/gpu/ws-relay.ts`, so the relay's `globalThis` cache is untouched and it
cannot collide with the other relay suites. Loopback addresses and invented
hostnames only.

Seven of the ten were confirmed failing before the fix:

| Test | Pre-fix |
|---|---|
| rekey onto an occupied slot does not drop a master | `masters.size` 2 → 1 |
| no `MasterConnection` outside the map keeps a live socket or timers | orphan `ws.readyState === OPEN` |
| `disconnectMaster` does not re-arm a reconnect | `wsReconnectTimer` non-null after disconnect |
| a reconnect for an object that no longer owns its key does nothing | orphan re-registered (1 → 2) |
| two slots that are aliases of one master do not ping-pong | **6 registrations in 5 s** |
| a `master-identity` push does not create a second slot | `masters.size` 1 → 2 |
| two duplicate slots started in the same tick do not ping-pong | 2 registrations (boot path) |

`npx jest src/lib/gpu --no-coverage` — 8 suites, 115 tests, green on three
consecutive runs, and green **without** `--forceExit` with no open-handle warning.
`npx tsc --noEmit` clean in `sideCar/`; no new errors at the root.


_Note: the endpoint claim in `connectMaster` is taken before the socket opens and released when the connection ends, because `connectAllMasters()` starts every disconnected slot in the same tick._


## Round 2 — correlated against the master's own log (`logs/dashboard.log`, 18:08)

The master-side burst (register → *Closing superseded sidecar socket* →
*Pushed master-identity frame* → *Auto-pushed config* → register, several times a
second) **corroborates the duplicate-slot mechanism rather than contradicting it**,
and it settles the one thing the earlier round left open.

- The sidecar has exactly two places that send a `register` frame:
  `connectMaster`'s `open` handler, and `reregisterOnLiveSockets` — which is only
  reached from `revalidateAgentUrl()`, and `startGossipClient` **deliberately never
  calls it**. So every *Sidecar registered via WebSocket* line on the master is a
  **brand-new socket from `connectMaster`**. The loop is the sidecar opening
  sockets, not the master closing them.
- **`masters=2` staying flat is consistent with this bug, not evidence against
  it.** Pre-fix, the `master-identity` push added a second slot for the master
  already connected (1 → 2), the watchdog connected it within 30 s, and the two
  slots then superseded each other forever with the count **flat at 2** —
  reproduced. That is not proof this host is the duplicate case: two genuinely
  distinct masters also sit at 2. **What discriminates it, in the operator's own
  log:** the duplicate case has two slots whose keys differ only as
  canonical-vs-LAN address for the same host and which dial the *same*
  `ws://host:port/sidecar`. On a sidecar carrying this fix that surfaces directly
  as `Duplicate master slot: <url> is already connected as <url>` at WARN — if
  that line appears, it was the duplicate; if it does not and the loop is gone
  anyway, the identity-push generator was the whole of it. The earlier `3 → 2` was
  the `rekeyMaster` clobber firing once, on top. The fix is correct either way:
  nothing regresses if the two masters are real.
- **The master pushes TWO frames per register, not one.** Task 42 named only the
  config push. Both are now covered by tests that mirror
  `src/lib/gpu/ws-relay.ts:418-521` exactly, including the
  *Skipped master-identity push: canonical URL unknown* branch — the sidecar must
  survive a cycle that carries no canonical URL, and does.

### A further defect this round exposed

**The `config` push's `serverUrl` rekey hijacked the key of a slot whose socket was
up.** With the collision fixed, a single-slot host was *worse off*: the rekey now
succeeded and moved the slot to the pushed canonical URL. That URL is not a
verified route — `src/lib/gpu/master-identity.ts` resolves it from
`SOUND_SUITE_MASTER_URL`, then a config key, then **the `Host` header of whatever
most recently hit the master** — and it is re-pushed on every register. Adopting it
for a live connection trades a working address for a guess, which is precisely the
failure `startGossipClient` warns about (task 41). The config handler now keeps the
key a live socket is on and rekeys only a slot that is **not** connected — the
recovery case the branch was written for. Test: *keeps the key that is working when
the pushed serverUrl is unverified* (it fails without this change, adopting
`http://master-canonical.invalid:3000`).

### Aggravator, fixed

`setup-overrides.ts` logged `Applied hostOs override: …` on **every** master config
push — i.e. on every register — which made a hot reconnect loop read as if the
override were flapping. The assignment was always idempotent; only the log was not.
Now logs on change only.

### Reported, not fixed (outside this task's territory)

- **`master-identity`'s canonical URL is unstable by construction.** Falling back
  to a request-derived `Host` header means the master can push URL A on one cycle,
  URL B on the next, and nothing on a third. That is a master-side fix in
  `src/lib/gpu/master-identity.ts`. The sidecar is now indifferent to it, but a
  master that cannot name itself consistently will keep confusing every consumer.
- **`Mode "ss-ocr" runtime "docker-ollama" not satisfiable on mac-docker-ollama —
  skipping` every cycle**, with matching `min-online: failed to acquire` retries.
  The master is assigning a Mac a role it cannot run. That is a role-assignment
  problem on the master, not a sidecar defect, and it is a plausible reason the
  push cycle keeps being re-triggered.
- `sideCar/src/app/page.tsx` currently has two `refreshRestartInfo` type errors in
  HEAD from task 45's restart button. Not mine; `npx tsc --noEmit` in `sideCar/`
  is otherwise clean.

Suite is now **14 tests** in
`src/lib/gpu/__tests__/sidecar-master-rekey.test.ts`; `npx jest src/lib/gpu`
is 8 suites / 119 tests, green on three consecutive runs.

### Harness note

The suite was intermittently timing out in `connectBoth` (1 run in 3). Cause was
in the harness, not the product: under parallel Jest workers the WS handshake can
miss `connectMaster`'s 5 s connect timeout, which terminates the socket and falls
back to HTTP gossip before retrying, so registration arrives a couple of backoff
steps later and an awaited single event reads as a hang. The fake master now polls
a registration **counter** (`waitForRegistrations`) instead of awaiting a one-shot
event, and `afterEach` retires every `MasterConnection` the suite created — not
only those still in `state.masters` — because an orphan keeps its own reconnect
timer and the fake masters bind ephemeral ports that the OS reuses. Green on five
consecutive full-directory runs after that.


## Round 3 — the 2.3.78 fleet regression: root cause is `m.wsPort ?? 3002`

**`connectMaster` guessed a ws port, and on a host running two masters the guess
lands on Sound Suite's relay.**

```ts
const wsPort = m.wsPort ?? 3002;
const wsUrl  = `ws://${serverHost}:${wsPort}/sidecar`;
```

`m.wsPort` arrives **only** in a `master-identity` frame. It is therefore undefined
for the whole first-connect window of every boot, and indefinitely for a master
that cannot identify itself at all (in the field: a stranded `HostProvisioning`
row → `resolveMasterEndpointForHost()` null → `buildMasterIdentityFrame()` null →
no frame → no wsPort). On the affected fleet **both masters live on one host**, so
`serverHost` is identical and the ws port is the *only* thing separating their
endpoints. A slot with no wsPort silently resolves onto `:3002` — Sound Suite's
relay — and registers there under the same `agentUrl` as the real Sound Suite slot.

The master supersedes per `agentUrl`, not per slot, so the two evict each other
continuously. Everything the operator observed follows from that, with no field
lying:

| Observation | Explanation |
|---|---|
| `mode: websocket`, `lastHeartbeatAt: never` | The heartbeat timer **is** armed in the `open` handler. The interval is 5 s and the connection is evicted every ~3.5 s, so it never fires once. |
| config write every ~3.5 s, `firstUrl` stable, `count=2` | That is `POLL_INTERVAL = 3_000`. The evicted slot's close handler runs `startHttpHeartbeat`, whose poll picks up the master's queued `/config`, applies it and calls `saveConfig()`. |
| `consecutiveFailures: 0`, `unreachable: false` | Correct. Nothing is failing — registration succeeds every cycle. |
| Two end states (`disconnected` on two hosts, `websocket` on one) | Same cause sampled at different points in a ~3.5 s cycle. |
| Fantom healthy on all five hosts, both versions | Fantom is the slot that *wins* :3002. Its heartbeats flow — to Sound Suite's relay, attributed to the Fantom slot. |
| 2.3.77 healthy, 2.3.78 broken | **The duplicate was an accidental repair.** On 2.3.77 the Sound Suite `master-identity` push called `ensureMaster(canonicalUrl, {wsPort})`, creating a second slot **carrying the correct explicit wsPort** — and that slot is the one that connected properly and heartbeated. Round 1 removed the duplicate, which removed the repair and exposed the defaulted-port defect underneath. |

So the version split is real and my change did expose it — but the defect is the
silent port default, which has been there all along, and reverting only restores
the accident that hid it.

### Fix

A defaulted port is a **guess**. If another non-retired master **on the same host**
holds that exact port explicitly, the guess is not merely unverified — it is
certainly wrong. `connectMaster` now refuses to dial it, reports
`connectionStatus = "Needs wsPort — <port> belongs to <url>"`, and keeps retrying on
the capped backoff, because an absent wsPort is not a permanent condition: the
identity frame that supplies it can arrive at any time. *Unreachable is not gone*,
and a missing wsPort is not a dead master.

Test: *a slot with no wsPort must not hijack a port another master holds* — fails
without the change. A second test binds a real listener on 3002 and skips cleanly
when the port is in use (it is, on this dev machine), so a port conflict never
reads as a verdict about the product.

### Why the team lead's earlier test failure was expected

`does not ping-pong when both duplicate slots are started in the same tick` fails
against **HEAD's** `ws-client.ts` and passes against the working tree. HEAD's
duplicate guard still carries `if (other.ws?.readyState !== WebSocket.OPEN) continue`,
and `connectAllMasters()` starts every slot in one tick, so at boot neither socket
is open and both proceed. The working tree takes the endpoint claim *before* the
socket opens. That failure is the test doing its job on the un-updated half.

### Rollback trade-off (asked for explicitly)

Reverting the sidecar half of `9d6f58b8` reintroduces, in order of severity:

1. the `master-identity` duplicate-slot generator and therefore the **~1 s supersede
   ping-pong** (measured 6 registrations / 5 s; 221 reconnects / 90 s from the master
   side) — *and* the accidental wsPort repair that hid the real bug;
2. the `rekeyMaster` silent clobber (`masters` 3 → 2, orphaned live connection);
3. `scheduleReconnect`'s key-instead-of-identity guard (orphans reconnect forever);
4. `disconnectMaster` re-arming the reconnect it just cancelled;
5. loss of `unreachable` reporting and the WARN on a lost slot.

Items 2-5 are pure guards that cannot produce the observed regression. **The only
two changes that alter steady-state connection behaviour are the
`master-identity` "no second slot" branch and the `connectMaster` endpoint claim.**
A revert that keeps 2-5 and drops only those two returns 2.3.77 behaviour exactly.
Shipping the defaulted-port fix instead keeps all of it and fixes the underlying
defect — that is the recommended path.
