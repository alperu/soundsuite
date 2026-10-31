# Sound Suite `fleet.source = local | follow` (task 57 / 3.6)

Status: implemented and deployed on basws42 (2026-10-31). Follow is ON there.
The old patch (`patches-sidecarmaster-fleet-source.patch`) is superseded by the code below.

## The setting

Admin → **Sidecar master** (tab before GPU Fleet) → route `/api/admin/sidecar-master`
(GET settings + status, PUT save, POST test connection). Admin role only.

| Config key | Meaning |
|---|---|
| `fleet.source` | `local` (default) or `follow` |
| `fleet.master.url` | Address Sound Suite reads from (on basws42: `http://10.10.20.192:3010`) |
| `fleet.master.linkUrl` | Address for the "open in sidecarmaster" links (optional) |
| `fleet.master.token` | App token from sidecarmaster (Apps → soundsuite → Issue token, scope `fleet:read`). Write-only: views and audit rows show only the last 4 characters |

Env values `SS_FLEET_SOURCE`, `SM_URL`, `SM_LINK_URL`, `SM_TOKEN` override the Config rows (tests, emergencies).

## What `follow` does

- Reads `GET {master}/api/v1/apps/soundsuite/fleet` with the token. Copy in memory for 30 s,
  last good copy in the `FleetSnapshot` table (system.db). The follower loop
  (`src/lib/gpu/fleet-follower.ts`, 10 s tick) refreshes the copy and holds one SSE connection to
  `/api/v1/events?app=soundsuite`; a `role.*`, `control.*`, `app.*`, `mode.*` or `reconcile.*`
  event triggers a read at once.
- Fallback order for a read: memory copy → master → stale memory copy → snapshot → local table.
- `listAssignmentsForHost` / `listAllAssignments` return sidecarmaster's rows, one per
  (sidecar URL or alias, mode). Host provisioning rows come from the same view.
- Sound Suite **stops**: role edits, host provisioning, config pushes (registration auto-push,
  idle timeouts, model registry, full config, OpenRouter re-push), master-URL reassert
  (watchdog + empty-masters trigger), min-online and mode distribution, container start/stop,
  model pull/load, image update, sidecar update, sidecar build downloads (`/api/admin/gpu/sidecars/version|download` answer 404).
- Sound Suite **keeps**: its relay on 3002 (sidecars still connect here, heartbeats fill the
  status cache), its own routing (`resolveEndpoint` is unchanged), the master-identity frame on
  registration (so a sidecar keeps this master's address), local switches (`gpu.mode`,
  `gpu.autoManage`, `*.useOrchestrator`).
- Pages GPU Fleet, Mode Types, Role Assignments, Host Provisioning show a "Read only. Managed by
  sidecarmaster at <url>" banner with a link to the same page in sidecarmaster; their controls are
  disabled. GPU Fleet shows a "Fleet from sidecarmaster" table above the local relay view.
- Write routes answer `409 { error, code: "FOLLOWING_SIDECARMASTER", managedBy }`.
  GET routes add `fleetSource` and `managedBy`.
- Audit: `ActionLog` rows `fleet.source.save`, `fleet.source.follow`, `fleet.source.local`,
  `fleet.source.test` (target `sidecarmaster`, no token in the detail).

## How to switch

1. sidecarmaster: Apps → soundsuite → Issue token (`fleet:read`). Copy it once.
2. Sound Suite: Admin → Sidecar master → master URL + token → Save → Test connection.
3. Turn **Follow sidecarmaster** on. The pages become read only within 10 s.
4. Back: turn the switch off (or `PUT /api/admin/sidecar-master {"source":"local"}`). No restart needed.

## Files

- `src/lib/db/fleet-source.ts` — settings, master client, snapshot, gates (`isFollowMode`, `followSkip`, `refuseInFollowMode`, `assertLocalWrites`), audit.
- `src/lib/gpu/fleet-follower.ts` — poll + SSE loop (started from worker-init).
- `src/lib/api/follow-mode-response.ts` — 409 answers.
- `src/app/api/admin/sidecar-master/route.ts` — the setting route.
- `src/components/admin/sidecar-master-panel.tsx`, `sidecar-master-fleet.tsx`, `managed-by-banner.tsx`.
- Gates in `fleet-router.ts`, `ws-relay.ts`, `sidecar-reconnect-watchdog.ts`, `reranker-watchdog.ts`, `role-registry.ts`, the four admin routes and the sidecar build routes.
- Prisma: model `FleetSnapshot`, migration `20261031020000_add_fleet_snapshot`, listed in `SYSTEM_MODELS` / `SYSTEM_TABLES`.

## Tests

- `src/lib/db/__tests__/fleet-source.test.ts` — settings, token masking, rows per alias, snapshot fallback, local write refusal, audit.
- `src/app/api/admin/__tests__/follow-mode-routes.test.ts` — 409 on every managed write, GET answers with `managedBy`, build routes 404.
- `src/lib/gpu/__tests__/fleet-router-follow-mode.test.ts` — min-online loop idle, start/stop refused, pushes skipped, routing still takes a lease (Q5).
- `src/components/__tests__/managed-by-banner.test.tsx` — the banner.
- sidecarmaster: `tests/public-fleet-view.test.ts` — the public view carries hostname, aliases, GPUs, version, containers.
