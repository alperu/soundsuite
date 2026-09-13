# An automatic address change never reaches the admin pages

**Status:** Proposed · **Effort:** S–M · **Priority:** P1 · **Created:** 2026-09-13
**Reported:** sidecars updated to the build carrying [task 41](./41-sidecar-address-drift.md),
but `/admin/hostprov` and `/admin/gpu` still show the previous address.
**Interacts with:** [task 41](./41-sidecar-address-drift.md) (address resolution) ·
[task 42](./42-sidecar-master-slot-churn.md) (the sidecar is reconnecting in a loop
on at least one host, which may mask or amplify this)

Field names and code citations only. No case data. `sideCar/` is published
publicly — do not put real addresses in anything under it.

## Item 1 findings (2026-09-13) — three premises REFUTED

**R1. Neither page renders a `HostProvisioning` row's address.** Both render the
address from `/api/admin/gpu-fleet`. `admin-host-provisioning.tsx:299-301`
iterates `sortedFleet` (built from `fleet`, fetched at line 143 from
`/api/admin/gpu-fleet`) and displays `{s.url}` at line 387; the provisioning row
is only looked up *by* that URL (`recordsByUrl[s.url]`, line 365) to populate the
override form fields. So the claim below that "`/admin/hostprov` renders the row"
is wrong, and **moving the row cannot fix the displayed address.**

**R2. The automatic provisioning-row carry already exists and is committed.**
`ws-relay.ts:446-479` (confirmed present in `HEAD`, not a working-tree edit)
moves the row when `movedFrom` is set, fire-and-forget with a `.catch()`. The
grep in "The gap" returned nothing only because it was scoped to the body of
`rekeySidecarAddress()`; the hook lives in the register handler that calls it.
**Item 2 is already built.** What it lacks is item 4 — see below.

**R3. Neither page is a stale client-side cache for the address.**
`admin-gpu-fleet.tsx:459-462` polls `/api/admin/gpu-fleet` every 5 s;
`admin-host-provisioning.tsx:187` polls every 5 s. The address does refetch.

### What each page actually reads

Both, identically: `/api/admin/gpu-fleet` → `getFleetStatus()`
(`fleet-router.ts:385-440`) = **the persisted `gpu.sidecars` list ∪ the status
cache**, merged by URL. Not the WS registry (`fleet-router.ts:390-393` explains
why it is unreadable from a route), and not a `HostProvisioning` row.

### The actual mechanism for the reported symptom: a status-cache ghost

`getFleetStatus()` synthesizes a fleet row for any status-cache entry not in the
persisted list (`fleet-router.ts:418-430`). Nothing ever evicts a cache entry on
disconnect: the `close` handler (`ws-relay.ts:588-603`) calls
`markSidecarDisconnected()`, which only flips `wsConnected = false`
(`status-cache.ts:345-351`); `removeSidecarFromCache()` is called solely by
`rekeySidecarAddress()` and `removeSidecar()`.

So on the **fresh-socket** path — a sidecar that *restarts* and comes back on a
new address, which is exactly what a self-update does — `rekeySidecarAddress()`
never runs (`registeredUrl` is unset on the new socket, so the branch at
`ws-relay.ts:392` is skipped), and that path is documented as deliberately
unhandled at `ws-relay.ts:155-159`. The new address registers as a new entry and
**the old address survives in the status cache indefinitely as a disconnected
row.** The same-socket path (`ws-client.ts:181-191`, task 41's revalidation tick)
is clean — it re-keys both stores.

Live DB check (read-only, `prisma/data/sound-suite.db`): `gpu.sidecars` holds 5
entries, all `connected` with current `lastSeen`, and the 5 `HostProvisioning`
rows key to **exactly the same 5 URLs** — zero orphans either way. The persisted
stores are currently consistent, which is expected: `persistSidecarList()`
rebuilds `gpu.sidecars` from the live map, so the ghost exists **only in memory**
and any master restart clears it. This also rules out a stale provisioning row as
the live cause.

### `DELETE` has no equivalent gap

`DELETE` (`route.ts:194-213`) clears one row by `sidecarUrl` and deliberately does
not touch the registry — its documented meaning is "master stops pushing identity
to this host", not "remove this host". There is no second store to keep in step,
so nothing to reconcile. It *can* leave a row keyed to an address the host has
since left, but that is the ghost problem above, not a `DELETE` bug.

### Item 6 is BLOCKED by territory

The provenance value exists on the sidecar — `agent-address.ts:143-144,249`
computes `env:AGENT_URL` / `env:EXTERNAL_IP` / `pinned-by-env` — but it is only
*logged* (`ws-client.ts:99`). The register frame carries `agentUrl`, `hostname`,
`containers` and nothing else (`ws-client.ts:185-189,1178-1183`), and the master
cannot surface a field it is never sent. Item 6 needs a `sideCar/**` change,
which this task may not make.

## The gap

There are **two** paths that change a sidecar's address, and only one of them
updates everything.

| Path | Live registry | Status cache | Provisioning row |
|---|---|---|---|
| `PATCH /api/admin/host-provisioning` (operator, manual) | ✅ | ✅ | ✅ |
| `rekeySidecarAddress()` in `ws-relay.ts` (automatic, on re-register) | ✅ | ✅ | ✅ ~~❌~~ (see R2 — it does, in the calling register handler; it just did not guard the destination) |

Verified: `src/app/api/admin/host-provisioning/route.ts:13,131,168` documents and
implements the manual path — *"moves the provisioning row AND re-keys the live
registry + status cache in one step, so no stale entry"*. Grepping
`rekeySidecarAddress` in `src/lib/gpu/ws-relay.ts` for `upsertProvisioning`,
`prisma`, `hostProvision` or `persist` returns **nothing**.
~~*(REFUTED — R2: the grep was scoped to that function's body; the carry lives in
the register handler that calls it, `ws-relay.ts:446-479`, and is in `HEAD`.)*~~

Provisioning rows are keyed by `sidecarUrl` (`route.ts:61,108-109`;
`src/lib/db/host-provisioning.ts:73`). So when a host moves by itself — which is
exactly what task 41 just made possible — the live fleet follows it while the
persisted row keeps the old address, and ~~`/admin/hostprov` renders the row~~
*(REFUTED — R1: it renders `s.url` from the fleet, never the row's address.)*

**The automatic path is now the common one.** Before task 41 a sidecar never
changed its own address, so the manual path was the only way this happened and
the gap could not show. Shipping 41 turned a dormant inconsistency into the
default experience.

## What to check before assuming this is the whole story

`/admin/gpu` and `/admin/hostprov` are different components
(`src/components/admin-gpu-fleet.tsx`, `admin-host-provisioning.tsx`) reading
different endpoints. Item 1 must establish, for **each page**, which of these it
renders:

- the live WS registry (follows the address today),
- the status cache (follows it today),
- the persisted `gpu.sidecars` list written by `persistSidecarList()`,
- a `HostProvisioning` row (does **not** follow it),
- or a client-side cache that simply is not refetching.

A page can be stale for a reason that has nothing to do with persistence — a
`useEffect` that fetches once, or an SWR/`revalidate` setting. **Do not assume the
provisioning row is the only cause.** Two pages showing a stale address may have
two different causes.

Also recorded during task 41 and relevant here: `persistSidecarList()` rebuilds
`gpu.sidecars` wholly from the live connection map, so operator-added entries and
their `note` fields are dropped on every register. If `/admin/gpu` reads that
list, its contents are already being rewritten frequently.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building.** For each of the two pages, trace the exact data source end to end and record it. | ☑ Done — R1/R2/R3 refuted; both pages read `getFleetStatus()`. Real cause is a status-cache ghost. |
| 2 | **Make the automatic path complete.** | ☑ Already existed in `HEAD` (`ws-relay.ts:446-479`) — premise refuted. Extracted to one shared function anyway, for item 4. |
| 3 | **Do not edit `ws-relay.ts`** — specify the hook instead. | ☑ Spec above, not applied. |
| 4 | **Decide what happens when the destination row already exists.** A named conflict, not a silent overwrite. | ☑ **This was the real unbuilt gap** — the committed carry upserted blind. Now guarded. |
| 5 | **Make the pages reflect reality without a manual reload.** | ☑ Both already polled every 5 s (R3). Fixed the separate once-at-mount `loadProvisioning()` bug. |
| 6 | **Show the address's provenance on the page.** | ☐ **BLOCKED** — the sidecar computes it but never sends it; needs a `sideCar/**` frame change. |
| 7 | Tests. | ☑ 11 cases on the guarded move. A "page fetch after a move" test is not meaningful given R1 — the page never read the row's address. |

## What was built (2026-09-13)

`src/lib/gpu/provisioning-address-move.ts` — `moveProvisioningAddress(from, to)`,
the single guarded implementation of the row move. Never throws (returns
`{status:'error'}`), issues **no write** unless a row exists at `from` and the
address really changed, and refuses an occupied destination with
`{status:'conflict', conflictWith}` instead of merging two rows (item 4).

`PATCH /api/admin/host-provisioning` now calls it
(`route.ts:155-172`) instead of its own inline copy, so the two callers cannot
drift. Its 409 body is unchanged. One deliberate behaviour change: the source row
is read **before** the destination is checked, so a `PATCH` where `from` has no
row no longer 409s on an occupied `to` — with nothing to move there is nothing
that could be silently lost, and the old ordering would have reported a conflict
for the ordinary post-move steady state. `PATCH` keeps its own `removeSidecar()`
call; the shared function only touches the row.

`admin-host-provisioning.tsx:187-196` — the 5 s timer now refetches
`loadProvisioning()` as well as `loadFleet()`. This is **not** the address-
staleness fix (R3: the address always polled); it fixes a separate real bug —
`recordsByUrl` was fetched once at mount, so after a host changed address the
override inputs rendered blank for a host that does have overrides. Drafts are
held separately in `draftByUrl` and `draftFor()` prefers them, so a refetch does
not clobber an operator mid-edit.

### The `ws-relay.ts` hook needed (item 3 — NOT applied here, task 42 holds the file)

Replace the body of the `if (movedFrom) { … }` block at **`ws-relay.ts:446-479`**
with a call to the shared function. Keep it fire-and-forget after the register
ack, exactly as now:

```ts
if (movedFrom) {
  const from = movedFrom;
  const to = msg.agentUrl;
  import('@/lib/gpu/provisioning-address-move').then(async ({ moveProvisioningAddress }) => {
    const r = await moveProvisioningAddress(from, to);
    if (r.status === 'moved') {
      logger.info('Host-provisioning row followed the address move', { from, to });
    } else if (r.status === 'conflict') {
      // Do NOT fail the registration: the live registry already moved. The row
      // is left for the operator to resolve on /admin/hostprov.
      logger.error('Host-provisioning row NOT moved — destination address already has a row', {
        from, to, conflictWith: r.conflictWith,
        detail: 'Neither row was changed. Delete the stale row to let the move complete.',
      });
    } else if (r.status === 'error') {
      logger.warn('Failed to move host-provisioning row after address change', { from, to, error: r.error });
    }
  }).catch((err) => {
    logger.warn('Failed to move host-provisioning row after address change', {
      from, to, error: (err as Error).message,
    });
  });
}
```

Error handling: nothing here may throw into the register handler or send a
non-`ok` register ack — the socket is already registered and acked by this point.
`no-row` and `noop` are silent and write nothing.

**Why the conflict log line is load-bearing.** A refused move leaves the moved
host's row at its OLD address. Immediately below this block the handler calls
`buildMasterIdentityFrame(msg.agentUrl)` (`ws-relay.ts:486`), which resolves via
`resolveMasterEndpointForHost()` → `getProvisioning(sidecarUrl)`
(`resolve-master-url-for-host.ts:30-35`) — keyed by the **new** address. So after a
refusal the moved host is pushed the **occupant row's** `masterUrlForHost` and
`masterWsPortForHost`, while its own row sits dead at the old key. That is still
the right call for item 4 (nothing merged, conflict named), but it is a silent
wrong the operator cannot infer from "conflict logged" — hence `logger.error` with
the resolution hint, not `warn`.

Risk 1 (task 42's ~1 s reconnect loop) **does not bite this call site**: the block
runs only when `movedFrom` is set, i.e. on a same-socket address change. A
reconnect loop arrives on fresh sockets, so it drives zero writes here.

### Open decision, deliberately NOT built: closing the ghost

The reported symptom needs the **status-cache ghost** evicted, and that is not a
persistence fix. Evicting on socket close is wrong — it would make every
genuinely-down host vanish from `/admin/gpu`, which is precisely what
`markSidecarDisconnected()` exists to prevent. Closing it properly requires
recognising a fresh-socket registration as the same host that held the old
address, the thing `ws-relay.ts:155-159` documents as unhandled pending a durable
sidecar identity. A hostname-match heuristic is available but wrong when two
hosts report the same hostname. **This is a named open choice, not an oversight**
— it wants the durable-identity decision (task 41 item 6), and the eviction
itself would land in `ws-relay.ts`, which this task may not edit.

**There is a working operator workaround today.** `removeSidecar()`
(`fleet-router.ts:492-521`) is the one reachable path that calls
`removeSidecarFromCache()`, and `/admin/gpu`'s remove action reaches it
(`gpu-fleet/route.ts` POST `action: 'remove'`). Removing the stale row from
`/admin/gpu` evicts the ghost. Safe for the live entry: `blockAgent()` is keyed by
the **normalized address** (`ws-relay.ts:201-211`), not by hostname, so blocking
the address the host has left does not touch its current registration. The block
lasts 60 s (`ws-relay.ts:119`) — the only caveat is that a host legitimately
returning to that same address within a minute would be refused once and retry.

### Tests

`src/lib/gpu/__tests__/provisioning-address-move.test.ts` — 11 cases, all
passing: overrides carried and old key left empty; upsert-before-delete ordering;
occupied destination refused with nothing merged; two hosts swapping addresses
both refused; no write when there is no row; idempotent on a repeated completed
move; no-op on an unchanged or empty address; a database failure reported rather
than thrown, with the old row intact.

`npx tsc --noEmit` clean for all three touched files. `npx jest src/lib/gpu/` — 86
pass; the only failing suite is `sidecar-master-rekey.test.ts`, which imports
`sideCar/src/lib/{state,ws-client}` exclusively (task 42's active territory) and
nothing this task touched.

## Risks

- **Task 42's reconnect loop is live on at least one host.** A sidecar
  re-registering roughly once per second would drive this reconcile path at the
  same rate. Any write added here must be idempotent and cheap, or it becomes a
  database write per second per host. Check what 42 finds before adding writes to
  the register path.
- **Do not make the register path fail on a provisioning write error.** A database
  problem must not prevent a sidecar from registering; log and continue.
- **Two sources of truth stay two sources of truth.** Moving the row on re-key
  makes them agree more often, it does not make them one thing. If the page can
  read the live registry directly for the address and use the row only for
  operator overrides, that is a smaller and more durable fix — evaluate it in
  item 1 before building item 2.

## Acceptance

| Check | Expected |
|---|---|
| A sidecar changes address by itself | `/admin/hostprov` and `/admin/gpu` both show the new address without operator action |
| The same host afterwards | one provisioning row, not two |
| A re-key onto an address another row holds | named conflict, nothing silently merged |
| A provisioning write failing | the sidecar still registers |
| An address shown on either page | its provenance is visible (pinned / detected / persisted) |

## References

- `src/app/api/admin/host-provisioning/route.ts:13,61,108-109,131,168`
- `src/lib/db/host-provisioning.ts:73` (`upsertProvisioning`)
- `src/lib/gpu/ws-relay.ts` — `rekeySidecarAddress()`, `persistSidecarList()`
- `src/components/admin-host-provisioning.tsx`, `src/components/admin-gpu-fleet.tsx`
- `src/app/api/admin/gpu-fleet/route.ts`
