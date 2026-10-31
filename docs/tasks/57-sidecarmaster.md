# Task 57 — sidecarmaster: implementation tasks

**Status:** Proposed · **Created:** 2026-10-30
See [`../SPEC-sidecarmaster.md`](../SPEC-sidecarmaster.md) and [`../roadmap-sidecarmaster.md`](../roadmap-sidecarmaster.md).

Scope: the management sidecar (`sideCar/`). Not the fileSystem sidecar.
No real addresses or tokens in anything under `sideCar/` (public).

---

## Phase 0: Decisions

### Task 0.1: Answer the open questions
**Priority:** P1
**Status:** Proposed

1. Answer SPEC §15 (repo, stack, join mode, updates, 3002 in follow mode, OpenRouter key, Fantom mode, stack deploy, alert channels, spam name, read-only users).
2. Record answers in SPEC §15.

Acceptance: every question has an answer and a date.

---

## Phase 1: Service shell

### Task 1.1: Repo and skeleton
**Priority:** P1
**Status:** Done (2026-10-30). Local repo only (no GitLab remote yet). Health is `/api/health`; Vitest smoke test in tests/api.test.ts.

1. Create `/Users/alper/Code/sidecarmaster` (GitLab `alperu/sidecarmaster`). Next.js + Prisma + SQLite + Vitest.
2. Layout as SPEC §4.1. Copy SPEC and this file to `docs/`.

Acceptance: `npm run build` and `npm test` pass. Test: one smoke test of `/api/v1/health`.

### Task 1.2: Docker image
**Priority:** P1
**Status:** In progress (2026-10-30). Dockerfile (standalone) done; `scripts/migrate.mjs` applies migrations at start. Data in volume `sidecarmaster-data`. GHCR workflow not done.

1. `docker/Dockerfile` (standalone output), `entrypoint.sh` runs `prisma migrate deploy` then start.
2. GHCR publish workflow, amd64 (arm64 later).

Acceptance: `docker run` starts, data in a volume survives restart. Test: CI builds the image.

### Task 1.3: NetBird + Caddy stack
**Priority:** P1
**Status:** In progress (2026-10-30). Entrypoints, caddy.Dockerfile, compose done; deployed to basws42 port 3010. `/sidecar*` WS route waits for Task 2.2. Cert waits for setup key + Cloudflare token.

1. Copy `mcpfantom/docker/{netbird,caddy}-entrypoint.sh` and `caddy.Dockerfile`.
2. `docker-compose.yml`: `sidecarmaster`, `sidecarmaster-netbird`, `sidecarmaster-caddy`, shared network, `/netbird-ctl` volume.
3. Caddyfile: `/sidecar*` → WS, rest → app.
4. Deploy to `C:\sidecar-deploy\sidecarmaster` on basws42 (only after approval).

Acceptance: `https://sidecarmaster.vpn.bas.co` has a valid Let's Encrypt cert on NetBird. Test: `curl -I` returns 200/302; cert names checked.

### Task 1.4: Settings — NetBird and HTTPS
**Priority:** P1
**Status:** Done (2026-10-30). NetBird tab + HTTPS with token help table and cert status. Secrets masked (last 4); audit rows redacted. Tests: tests/netbird.test.ts, tests/api.test.ts.

1. NetBird tab (setup key, hostname, management URL, Advanced WireGuard port).
2. HTTPS part (on/off, domain, Cloudflare token, cert status) with the token help table.
3. Writes `/netbird-ctl/config.json` (0600); reads `status.json`, `caddy-status.json`.

Acceptance: API returns secrets masked (last 4 only). Tests: mask test; secrets never in logs (log capture test).

### Task 1.5: Admin login and audit log
**Priority:** P1
**Status:** Done (2026-10-30). Argon2id, first admin from SM_ADMIN_USERNAME/SM_ADMIN_PASSWORD, sessions, logout, AuditLog page. Tests: 401 without login, audit row on write.

1. `AdminUser` (Argon2id), sessions, logout.
2. `AuditLog` for every write.

Acceptance: pages need login. Tests: unauthenticated request → 401; write creates one audit row.

---

## Phase 2: Move the master (read-only)

### Task 2.1: Protocol package
**Priority:** P1
**Status:** Done (2026-10-31, branch phase2-live). `src/lib/protocol/` (v1 + v2 frame types, parsers, `X-Sidecar-Protocol` header). Golden fixtures in `src/lib/protocol/fixtures.ts`. Not published as an npm package yet. Tests: tests/protocol.test.ts.

1. `src/lib/protocol/` with frame types for v1 (`register`, `heartbeat`, `result`, `command`, `config`, `master-identity`) and v2 (`masters`, `masters-ack`).
2. Golden JSON fixtures. Publish as `@sidecarmaster/protocol`.

Acceptance: Sound Suite and Fantom frame shapes match fixtures. Test: fixture round-trip tests.

### Task 2.2: Move WS relay, queue, status cache
**Priority:** P1
**Status:** Done (2026-10-31, branch phase2-live). Relay in `src/lib/relay/` on `ws://:SM_RELAY_PORT(3002)/sidecar` (own port, like Sound Suite; not on the HTTP server yet). Kept: register timeout, ping tolerance, superseded-socket grace, address-move conflict refusal, master-identity push. Not ported (Phase 3/4): config auto-push, OpenRouter re-push, reassert watchdog. HTTP fallback routes done; DB `Command` queue. Interfaces for other phases: `CommandSender`, `FleetStatus`, `HeartbeatSource` in `src/lib/fleet/interfaces.ts`. Optional bearer `SM_SIDECAR_TOKEN`. Tests: tests/relay.test.ts (fake v1 sidecar), tests/relay-http.test.ts.

1. Port `ws-relay.ts`, `command-queue.ts`, `status-cache.ts`, `master-identity.ts` from Sound Suite.
2. Keep the superseded-socket grace (task 46 Part B).
3. WS on the same HTTP server (`/sidecar` upgrade) and on a NetBird port for `ws://` v1.
4. HTTP fallback routes `/api/admin/gpu/sidecars/{register,heartbeat,poll,result}`.

Acceptance: a v1 sidecar connects with no change. Tests: port `sidecar-master-rekey.test.ts` and relay tests; superseded socket reaped after grace.

### Task 2.3: Data model
**Priority:** P1
**Status:** Done (2026-10-30). Schema + migration; AES-256-GCM with SM_SECRET_KEY. Tests: tests/crypto.test.ts.

1. Prisma models from SPEC §5.1.
2. Secret encryption helper (AES-256-GCM, `SM_SECRET_KEY`).

Acceptance: migration applies on empty DB. Tests: encrypt/decrypt; unique keys.

### Task 2.4: Importer from Sound Suite
**Priority:** P1
**Status:** Done (2026-10-30). `npm run import:soundsuite -- --system-db … [--config-db …] [--dry-run]`; also runs every 5 min in the container. Read-only open (copy fallback for live WAL). Tests: tests/importer.test.ts.

1. `sidecarmaster import-soundsuite --system-db --config-db [--dry-run]` (SPEC §5.3).
2. Read-only on Sound Suite files. Upsert, re-runnable. Diff report.

Acceptance: dry run prints the plan; real run twice gives the same rows. Tests: fixture DBs; duplicate host by hostname is reported.

### Task 2.5: Fleet page (read-only)
**Priority:** P1
**Status:** Done (2026-10-31, branch phase2-live). /gpu shows live status by SSE (`/api/fleet/live`): connected, transport, last heartbeat, sidecar + protocol version, GPUs, containers, all URLs. Hosts are de-duplicated by hostname (one Host per box, URLs in `HostAlias`); the importer merges old duplicate rows. Tests: tests/fleet-view.test.ts, tests/importer.test.ts.

1. Port `admin-gpu-fleet.tsx` view parts. Live status by SSE.

Acceptance: all 5 hosts shown with GPUs, containers, last heartbeat. Test: component test with a status fixture.

### Task 2.6: Add sidecarmaster as an extra master (M1)
**Priority:** P1
**Status:** Proposed. Waits for user approval. Steps written in sidecarmaster `docs/m1-extra-master.md` (branch phase2-live). No sidecar changed.

1. Add `SIDECARMASTER_MASTER_URL` to `configure-sidecar-masters-netbird.sh` (last use of the script).
2. Run `--dry-run`, then real, after approval.

Acceptance: every sidecar's `/api/masters` lists sidecarmaster; Sound Suite master still connected. Test: script dry-run output reviewed.

---

## Phase 3: Control and app registry

### Task 3.1: App registry
**Priority:** P1
**Status:** Done (branch `phase3-control`)

1. `App`, `AppMode` CRUD + UI. Seed: soundsuite, fantom, axon, quickbooks, expedat, spam.
2. Sound Suite's 7 modes from `mode-catalog.ts` become `soundsuite` modes.

Acceptance: new app added from UI only. Tests: CRUD API; port clash refused.

Done: `src/lib/control/registry.ts`, `/registry`, `/api/apps`. Seeds 6 apps; Fantom has `fantom-code-embedding` (port 11438). Port clash → 409. Every change audited.

### Task 3.2: Roles and host provisioning pages
**Priority:** P1
**Status:** Done (branch `phase3-control`)

1. Port `admin-role-assignments.tsx`, `admin-host-provisioning.tsx`, `admin-role-types.tsx`, per app.
2. Keyed by `hostId`.

Acceptance: same features as Sound Suite pages. Tests: port `admin-role-assignments-ports.test.ts`.

Done: `/roletypes`, `/roleassign`, `/hostprov` are editable, keyed by `hostId`. Ports test ported (`tests/control-ports.test.ts`).

### Task 3.3: Config push and min-online
**Priority:** P1
**Status:** Code done; needs live relay

1. Port `pushFullConfig`, `pushIdleTimeouts`, `pushModelRegistry`, min-online loop from `fleet-router.ts`.
2. Push the per-app mode catalog in `registry`.

Acceptance: enabling a role starts the container within 60 s. Test: integration test with a fake sidecar.

Done: `src/lib/control/policy.ts` (config frame with per-app `registry`, min-online). Tested with `InMemoryCommandSender`. The 60 s acceptance needs the Phase 2 relay (`setCommandSender`).

### Task 3.4: Reconcile loop
**Priority:** P1
**Status:** Code done; needs live relay

1. Every 30 s compare desired vs reported; queue fixes; write audit rows.

Acceptance: a stopped desired container restarts. Tests: reconcile unit tests (no-op, start, stop, give up after 3 tries).

Done: `src/lib/control/reconcile.ts`, 30 s loop, 3 tries then give up, audit actor `reconcile`. Idle until a CommandSender is set.

### Task 3.5: Public API for apps
**Priority:** P1
**Status:** Done (branch `phase3-control`)

1. `GET /api/v1/apps/:id/fleet`, `GET /api/v1/hosts`, SSE `/api/v1/events?app=`.
2. Per-app API tokens with scopes.

Acceptance: wrong scope → 403. Tests: auth and scope tests.

Done: `/api/v1/apps/:id/fleet`, `/api/v1/apps/:id/roles`, `/api/v1/hosts`, `/api/v1/events` (SSE), `/api/v1/modes`. Tokens `smk_<app>_…`, sha256 stored, scopes fleet:read / fleet:write / commands.

### Task 3.6: Sound Suite `fleet.source` switch
**Priority:** P1
**Status:** Done (deployed on basws42 2026-10-31, Follow ON). See `docs/sidecarmaster-fleet-source.md`.

1. In Sound Suite: `src/lib/gpu/fleet-source.ts` (local/follow), `FleetSnapshot` cache in `system.db`.
2. `role-registry.ts`, `fleet-router.ts` read through it. `follow` turns off min-online and blocks local writes.
3. Read-only banner on the four admin tabs.

Acceptance: `follow` routes on sidecarmaster data; sidecarmaster down → last snapshot used; back to `local` works. Tests: unit tests for both modes and snapshot fallback.

Patch + doc: `docs/patches-sidecarmaster-fleet-source.patch`, `docs/sidecarmaster-fleet-source.md`. Covers reads through sidecarmaster, write block, 30 s in-memory cache with fallback. Not yet: `FleetSnapshot` in `system.db`, min-online off in follow, read-only banner, Sound Suite tests.

### Task 3.7: Sidecar reads mode catalog from master
**Priority:** P2
**Status:** Partial: master side done

1. `sideCar/src/lib/mode-templates.ts`: resolve from pushed `registry`; built-in templates as fallback.

Acceptance: a non-Sound-Suite mode starts. Tests: sidecar unit tests.

Master side: `GET /api/v1/modes?os=` and the `registry` in every config push, in the sidecar `ContainerDef` shape. Sidecar `mode-templates.ts` change not done (out of scope for this branch).

---

## Phase 4: Auto masters (protocol v2)

### Task 4.1: Host join
**Priority:** P1
**Status:** Proposed

1. `POST /api/v1/hosts/join` → `hostId`, `hostToken`. Single-use join tokens, 24 h. Optional approval.
2. v1 adoption: mint `hostId` from URL.

Acceptance: token reuse rejected. Tests: join, reuse, expiry, revoke.

### Task 4.2: Sidecar bootstrap
**Priority:** P1
**Status:** Proposed

1. `SIDECARMASTER_URL`, `SIDECARMASTER_JOIN_TOKEN`; save `hostId`/`hostToken` 0600.
2. Bearer on WS upgrade; `X-Sidecar-Protocol: 2`.

Acceptance: fresh sidecar with only these two values connects. Test: sidecar integration test.

### Task 4.3: `masters` frame
**Priority:** P1
**Status:** Proposed

1. Diff by `appId`; update in place, never rekey; `managed` flag; `masters-ack`.
2. Freeze switch per host.

Acceptance: no reconnect loop when list changes. Tests: add/update/remove; manual entry untouched; reconnect count stays 1 per master over 60 s.

### Task 4.4: `wsUrl` and wss
**Priority:** P1
**Status:** Proposed

1. `MasterEntry.wsUrl`; dial as given. Old `ws://host:wsPort` rule kept.
2. Add `/sidecar` route to Caddy of soundsuite, fantom, qbmcpserver (and spam if Q10 yes).

Acceptance: sidecars connect over `wss://<app>.vpn.bas.co/sidecar`. Tests: unit test URL choice; live check per app.

### Task 4.5: Per-app policy namespace
**Priority:** P1
**Status:** Proposed

1. `idleTimeouts`/`minOnline`/`registry` per `appId` on the sidecar; conflicts reported in heartbeat.

Acceptance: two masters no longer overwrite each other. Tests: conflict unit tests.

### Task 4.6: Drift healing
**Priority:** P1
**Status:** Proposed

1. Heartbeat carries `mastersRev`, `policyRev`, masters status. Resend on old rev. Observed address used (task 44).

Acceptance: a master deleted by hand on a host comes back within 60 s (unless frozen). Test: integration test.

### Task 4.7: Field rollout
**Priority:** P1
**Status:** Proposed

1. Release sidecar ≥ 2.5. Update one host per day (order in roadmap).

Acceptance: all hosts on v2, healthy 2 weeks. Test: rollout checklist per host.

---

## Phase 5: Dashboard and alerts

### Task 5.1: Host and app pages
**Priority:** P1
**Status:** Proposed

1. SPEC §11 pages; actions: restart sidecar, update, provision, freeze.

Acceptance: answers "which host is down, which app runs where". Tests: component tests with fixtures.

Done on branch `phase5-dashboard` (2026-10-30): overview = dashboard (hosts × apps grid, open alerts), `/gpu/<id>` host page, `/apps`, `/apps/<id>`. Data comes through `FleetStatus` (`src/lib/fleet/interfaces.ts`) and `AppRegistry` (`src/lib/apps/interfaces.ts`); until Phase 2/3 register real ones, they read the Host / App tables. Action buttons call `FleetControl`; without Phase 2 they answer 501. Tests: `tests/monitor.test.ts` (grid).

### Task 5.2: Heartbeat samples
**Priority:** P2
**Status:** Proposed

1. 60 s samples, 7-day ring; charts for GPU and active requests.

Acceptance: DB size stays bounded. Test: pruning test.

Done on branch `phase5-dashboard` (2026-10-30): `HeartbeatSample` (7 days) + `HeartbeatHourly` roll-up (90 days), SVG charts on the host page. Test: `tests/monitor.test.ts`.

### Task 5.3: Alert rules
**Priority:** P1
**Status:** Proposed

1. Rules in SPEC §11; states open/ack/closed; mute.

Acceptance: host off network → alert < 2 min; closes on return. Tests: rule unit tests with fake clock.

Done on branch `phase5-dashboard` (2026-10-30): rules host-down (warning, then critical), app-down (health probe, master link), update-failed, disk-low, gpu-high; limits on `/alerts`; ack, close, mute per alert and timed mutes per rule/host/app. Loop every 30 s (`SM_MONITOR=0` turns it off). Tests: `tests/alerts.test.ts` (fake clock).

### Task 5.4: Notifiers
**Priority:** P2
**Status:** Proposed

1. Email; webhook (Slack/ntfy) per Q9.

Acceptance: test button sends a message. Tests: notifier mocks.

Email done on branch `phase5-dashboard` (2026-10-30) (SMTP settings + cool-down per alert key). Webhook not done.

### Task 5.5: `/metrics`
**Priority:** P3
**Status:** Proposed

1. Prometheus text format, token protected.

Acceptance: Prometheus can scrape. Test: format snapshot test.

Done on branch `phase5-dashboard` (2026-10-30): `GET /metrics` with `Authorization: Bearer <SM_METRICS_TOKEN>` (or Setting `metrics.token`); off when no token. Tests: `tests/monitor.test.ts`, `tests/metrics-route.test.ts`.

---

## Phase 6: Retire and extend

### Task 6.1: Delete master scripts
**Priority:** P2
**Status:** Proposed

1. After 2 clean weeks, remove `configure-sidecar-masters*.sh` and `configure-sidecar-delete-masters.sh`.

Acceptance: no doc points to them. Test: `grep` finds no use.

### Task 6.2: Fantom uses the API
**Priority:** P3
**Status:** Proposed

1. `mcpfantom/src/sidecars/registry.ts` reads fleet data from sidecarmaster.

Acceptance: Fantom fleet view matches sidecarmaster. Test: Fantom unit test with API mock.

### Task 6.3: Stack deploy (optional, Q8)
**Priority:** P3
**Status:** Proposed

1. Sidecar `stack.apply` runs `docker compose -p <appId> up -d`; image allow-list per app.

Acceptance: deploy and roll back one test stack. Tests: allow-list refusal test.

### Task 6.4: Sidecar local API auth
**Priority:** P2
**Status:** Proposed

1. `/api/masters` and other write routes need the host token or local-only.

Acceptance: remote write without token → 401. Tests: route tests.

## Added 2026-10-30: email alerts (SMTP)

**Priority:** P1 · **Status:** Done on branch `phase5-dashboard` (2026-10-30). Items 1-4 done: alert emails with cool-down in `src/lib/alerts/` (tests/alerts.test.ts, tests/smtp.test.ts).

1. Settings → Alerts: SMTP host, port, TLS mode (none, STARTTLS, TLS), username, password (masked, last 4, never logged), from address, recipient list.
2. "Send test email" button that reports the SMTP result.
3. Alerts by email: sidecar down (no heartbeat for N minutes), app master down, host back up, update failed, disk or GPU over a limit. One email per event with a cool-down so a flapping host does not flood the inbox.
4. Tests with a fake SMTP server: settings saved, password never returned, test email sent, cool-down works.

## Added 2026-10-30: release and update server for all sidecars

**Priority:** P1 · **Status:** In progress. Items 1, 2 done on branch `phase5-dashboard` (2026-10-30): feed with channel and `?host=` rollout; Releases page (upload with SHA-256, add by URL, import a GitLab release from its update-<platform>.json assets, token stored encrypted), per-host versions, rollout all / some hosts / hold. Items 3, 4 (sidecar side) and the rollback test not done. Tests: tests/releases.test.ts.

The Docker/GPU management sidecar update code lives in Sound Suite today:
`src/app/api/admin/gpu/sidecars/version/route.ts`, `src/app/api/admin/gpu/sidecars/download/route.ts`
and the update commands in `src/lib/gpu/ws-relay.ts` / `command-queue.ts`. Move it to sidecarmaster,
and extend it to the fileSystem sidecar.

1. sidecarmaster serves one update feed per product and platform:
   `GET /api/updates/<product>/<platform>` → `{ version, build, url, sha256, notes, minOS }`.
   Products: `docker-sidecar` (management sidecar), `filesystem-sidecar` (Mac app, Windows tray app, Linux binary).
   The format is in `fileSystemSideCar/docs/update-feed.md`.
2. Admin "Releases" page: upload a build (or point to a GitLab release), set channel (stable, beta),
   see which host runs which version of each sidecar, and roll out per host or to all.
3. Default update URL in every sidecar: `https://sidecarmaster.vpn.bas.co/api/updates/...`.
   Docker sidecars switch from Sound Suite's version/download routes to this feed.
4. Updates are automatic (user decision), with the SHA-256 checked before install and the old build kept for rollback.
5. Tests: feed answers per product and platform, wrong hash refused, rollout per host, rollback.

## Added 2026-10-30: release and update server for all sidecars

**Priority:** P1 · **Status:** See the section above (same task, items 1, 2 done on branch `phase5-dashboard` (2026-10-30)).

The Docker/GPU management sidecar update code lives in Sound Suite today:
`src/app/api/admin/gpu/sidecars/version/route.ts`, `src/app/api/admin/gpu/sidecars/download/route.ts`
and the update commands in `src/lib/gpu/ws-relay.ts` and `command-queue.ts`. Move it to sidecarmaster,
and extend it to the fileSystem sidecar.

1. sidecarmaster serves one update feed per product and platform:
   `GET /api/updates/<product>/<platform>` returns `{ version, build, url, sha256, notes, minOS }`.
   Products: `docker-sidecar` (management sidecar) and `filesystem-sidecar` (Mac app, Windows tray app, Linux binary).
   The format is in `fileSystemSideCar/docs/update-feed.md`.
2. Admin "Releases" page: upload a build (or point to a GitLab release), set the channel (stable, beta),
   see which host runs which version of each sidecar, and roll out per host or to all.
3. Default update URL in every sidecar: `https://sidecarmaster.vpn.bas.co/api/updates/...`.
   Docker sidecars move from Sound Suite's version and download routes to this feed.
4. Updates are automatic (user decision). The SHA-256 is checked before install, and the old build is kept for rollback.
5. Tests: the feed answers per product and platform, a wrong hash is refused, rollout per host works, rollback works.
