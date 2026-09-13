# An automatic address change never reaches the admin pages

**Status:** Proposed · **Effort:** S–M · **Priority:** P1 · **Created:** 2026-09-13
**Reported:** sidecars updated to the build carrying [task 41](./41-sidecar-address-drift.md),
but `/admin/hostprov` and `/admin/gpu` still show the previous address.
**Interacts with:** [task 41](./41-sidecar-address-drift.md) (address resolution) ·
[task 42](./42-sidecar-master-slot-churn.md) (the sidecar is reconnecting in a loop
on at least one host, which may mask or amplify this)

Field names and code citations only. No case data. `sideCar/` is published
publicly — do not put real addresses in anything under it.

## The gap

There are **two** paths that change a sidecar's address, and only one of them
updates everything.

| Path | Live registry | Status cache | Provisioning row |
|---|---|---|---|
| `PATCH /api/admin/host-provisioning` (operator, manual) | ✅ | ✅ | ✅ |
| `rekeySidecarAddress()` in `ws-relay.ts` (automatic, on re-register) | ✅ | ✅ | ❌ |

Verified: `src/app/api/admin/host-provisioning/route.ts:13,131,168` documents and
implements the manual path — *"moves the provisioning row AND re-keys the live
registry + status cache in one step, so no stale entry"*. Grepping
`rekeySidecarAddress` in `src/lib/gpu/ws-relay.ts` for `upsertProvisioning`,
`prisma`, `hostProvision` or `persist` returns **nothing**.

Provisioning rows are keyed by `sidecarUrl` (`route.ts:61,108-109`;
`src/lib/db/host-provisioning.ts:73`). So when a host moves by itself — which is
exactly what task 41 just made possible — the live fleet follows it while the
persisted row keeps the old address, and `/admin/hostprov` renders the row.

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
| 1 | **Confirm before building.** For each of the two pages, trace the exact data source end to end and record it. Verify the `PATCH`-vs-`rekeySidecarAddress` asymmetry above still holds, and check whether `DELETE` has the same gap. | ☐ |
| 2 | **Make the automatic path complete.** When a sidecar re-registers from a new address, the provisioning row must move with it — the same work `PATCH` already does. Prefer extracting the existing move into one reusable function over writing a second implementation that will drift from the first. | ☐ |
| 3 | **Do not edit `ws-relay.ts` in this task** — it is held by [task 42](./42-sidecar-master-slot-churn.md). Expose the reconcile function and specify the exact call site and arguments; the hook gets applied separately. | ☐ |
| 4 | **Decide what happens when the destination row already exists.** Two hosts swapping addresses, or a host moving onto an address another host used to hold, must not silently merge two provisioning rows. Same rule as the registry: a named conflict, not a silent overwrite. | ☐ |
| 5 | **Make the pages reflect reality without a manual reload**, if item 1 shows the staleness is client-side. State the refresh mechanism chosen and why; polling a fleet endpoint every few seconds is acceptable, silently caching for the session is not. | ☐ |
| 6 | **Show the address's provenance on the page.** An operator looking at a stale value cannot currently tell whether it is pinned (`AGENT_URL`/`EXTERNAL_IP`), detected, or a leftover row. Surfacing which one it is makes this class of bug self-diagnosing — task 41 already computes it. | ☐ |
| 7 | Tests: an automatic re-key moves the provisioning row; a re-key onto an occupied row is refused with a named conflict; a page fetch after a move returns the new address. | ☐ |

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
