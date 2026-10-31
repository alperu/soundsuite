# SPEC — sidecarmaster: one standalone master for the management sidecars

**Status:** Proposed (plan only, nothing built) · **Created:** 2026-10-30
**Roadmap:** [`roadmap-sidecarmaster.md`](./roadmap-sidecarmaster.md) · **Tasks:** [`tasks/57-sidecarmaster.md`](./tasks/57-sidecarmaster.md)

No case data. Addresses in anything under `sideCar/` must stay generic (it is public).

---

## 0. Two sidecars — keep them apart

| | **Management sidecar** (this spec) | **fileSystem sidecar** (NOT in scope) |
|---|---|---|
| Code | `court-lens-mcp/sideCar/` (TypeScript, Next.js, port 8098) | `/Users/alper/Code/fileSystemSideCar` (Rust) |
| Job | Docker containers, GPU roles, models, leases | File sync, FlatBuffers, tus |
| Hosts | BASWS34, BASWS41, BASWS35, Mac-mini, mcpserver | user machines, ExpeDat, QuickBooks receiver |
| Master today | Sound Suite `src/lib/gpu/*` (WS 3002) + Fantom, QuickBooks, spam filter | ExpeDat / Sound Suite fs link |

In this doc "sidecar" means the **management sidecar** only.

---

## 1. Goals

1. Move the master features (GPU fleet, role types, role assignment, host provisioning) into a new
   standalone service **sidecarmaster**: own repo (`/Users/alper/Code/sidecarmaster`), own Docker image.
2. Keep the master code in Sound Suite. Sound Suite can **follow** sidecarmaster. A switch chooses.
3. Host provisioning for **all apps** (Sound Suite, Fantom, Axon, QuickBooks, ExpeDat, spam filter, future).
4. No more `configure-sidecar-masters*.sh`. Sidecars get their masters from sidecarmaster, stay in
   sync, heal drift, and use `wss://` through Caddy.
5. One dashboard: which host is down, which app runs where, what it is doing, alerts.

Non-goals: the fileSystem sidecar; replacing the per-request router inside each app (§8);
multi-tenant SaaS (see `SPEC-saas-hosted-multi-tenant.md`).

---

## 2. Prior work found in `docs/` (build on it)

| Doc | What it decided | How this spec uses it |
|---|---|---|
| `sidecar-gossip-spec.md` | All links are **outbound from the sidecar**. WS primary, HTTP poll fallback (`/api/admin/gpu/sidecars/{heartbeat,poll,result}`), `SidecarCommand` queue. | Kept. sidecarmaster speaks the same frames and fallback routes. |
| `TODO-gpu-orchestrator.md` | The Next.js app is the **central router**; sidecars manage local containers; mode/dedicated/scaled GPU models. | Split: fleet **control** moves to sidecarmaster; per-request **routing** stays in each app (§8). |
| `sidecar-multimaster-changes.md` (2026-05-07) | A sidecar talks to N masters; frames are bit-identical per master; `/api/masters` CRUD. v2 list: per-master namespacing of `idleTimeouts/minOnline/registry`, bearer auth on `/api/masters`, mTLS, `max` idle-timeout rule. | sidecarmaster becomes the **owner** of policy, which solves the "last writer wins" v1 limit. The v2 auth items are in §10. |
| `MCP-Improvements/REPORT-v17-master-socket-obligations.md`, `tasks/46-one-master-one-socket.md` | One master = one socket. Client refuses a second socket; master marks superseded sockets and reaps after a 45 s grace. "Part B is not a stopgap." | sidecarmaster must copy Part B from `ws-relay.ts`. Fantom's `soundsuiteMaster.ts` is a second copy of the protocol — a reason to have one master. |
| `tasks/42-sidecar-master-slot-churn.md` | A `config` push that rekeys a master slot caused a ~1 s reconnect loop. | Master list changes go through a new `masters` frame (§6) that is diffed, never a rekey. |
| `tasks/41`, `43`, `44` (address drift, provisioning row, drop `EXTERNAL_IP`) | The address a sidecar advertises goes stale; the master already sees the real peer address; provisioning rows keyed by URL get stranded. | sidecarmaster keys hosts by a **stable `hostId`**, not by URL (§5). Address is data, not the key. |
| `tasks/45-sidecar-self-restart-button.md` | Restart the sidecar's own container, not the Docker engine. | Dashboard action reuses it. |
| `tasks/40-fleet-admission-control.md`, `39-role-aware-readiness.md` | `resolveEndpoint` is per request, GPU-aware; no admission limit. | Routing stays in apps; sidecarmaster only publishes the fleet view they route on. |
| `tasks/50-rlm-sandbox-unassignable.md`, `51-sidecar-roles-to-openrouter.md` | Mode catalog, runtimes (`RUNTIME_VALUES`), OpenRouter spillover per role. | The mode catalog becomes per-app data in the app registry (§7). |
| `tasks/56-system-db.md` | Fleet tables are **machine state**: `SidecarCommand`, `HostProvisioning`, `HostRoleAssignment` (+ `AdminUser`, `McpSession`, `ModelDownload`) live in `data/system.db`. | These are exactly the tables that move. `system.db` is the migration source (§5.3). |
| `roadmap-docker-mcp.md` | Docker image, `prisma migrate deploy` in entrypoint, GHCR publish. | sidecarmaster follows the same packaging. |
| `fileSystemSideCar/docs/https-netbird.md` | Per-service stack: `<svc>`, `<svc>-netbird`, `<svc>-caddy`; `/netbird-ctl/config.json`; one Cloudflare token. | sidecarmaster uses the same model (§9). |

No earlier doc proposed a standalone master service. This spec is new on that point. It does not
reverse any decision above. One change of direction: `TODO-gpu-orchestrator.md` made Sound Suite
the central router *and* the fleet owner. This spec keeps it the router for its own requests but
moves fleet ownership out, because five apps now share the fleet.

---

## 3. Current state (what exists, file:line)

### 3.1 Master code in Sound Suite (`court-lens-mcp`)

| Piece | Where | Notes |
|---|---|---|
| WS relay | `src/lib/gpu/ws-relay.ts:31` (`GPU_WS_PORT` 3002), `:421` (`path: '/sidecar'`), `:464` register, `:632` heartbeat, `:722` result, `:790` `sendCommand` | 866 lines. Superseded-socket grace (task 46). |
| Fleet router | `src/lib/gpu/fleet-router.ts` (1996 lines): `:407-419` sidecar list in Config key `gpu.sidecars` (JSON), `:433` `getFleetStatus`, `:1062` `pushFullConfig`, `:1235` `resolveEndpoint`, `:1678` `releaseEndpoint`, `:1809` `startMinOnlineEnforcement` | Mixes fleet control and per-request routing. |
| Command queue | `src/lib/gpu/command-queue.ts:54` queue, `:142` result, `:191` fetch, `:249` cleanup loop | Prisma `SidecarCommand`. |
| Master identity | `src/lib/gpu/master-identity.ts:64` canonical URL, `:95-117` `master-identity` frame `{canonicalUrl, wsPort, name}`, `:119` header `X-Sound-Suite-Master-Url` | The only way a sidecar learns `wsPort` today. |
| Per-host master URL | `src/lib/gpu/resolve-master-url-for-host.ts:13,25` | Reads `HostProvisioning.masterUrlForHost/masterWsPortForHost`. |
| Status cache | `src/lib/gpu/status-cache.ts` | In-memory, fed by heartbeats. |
| Others | `sidecar-reconnect-watchdog.ts:302`, `provisioning-address-move.ts:62`, `sidecar-address-probe.ts`, `mode-catalog.ts:71-118` (7 modes), `mode-catalog-server.ts:55` (reads Config), `ocr-model-caps.ts`, `ollama-version.ts`, `virtual-embed-dispatch.ts`, `cloud-provider.ts` | |
| DB helpers | `src/lib/db/role-registry.ts` (`HostRoleAssignment`, `RUNTIME_VALUES`), `src/lib/db/host-provisioning.ts:59-102` | |
| Start-up | `src/services/worker-init.ts:508` relay, `:517` queue cleanup, `:526` min-online | |
| Admin UI | `src/components/admin-gpu-fleet.tsx` (1895), `admin-role-types.tsx` (392), `admin-role-assignments.tsx` (1300), `admin-host-provisioning.tsx` (531); tabs in `src/components/admin-dashboard.tsx:43-46,446-449`; `src/app/admin/[[...tab]]/page.tsx:8`; `src/app/admin/host-provisioning/page.tsx` | |
| Admin API | `src/app/api/admin/{gpu/sidecars/{register,heartbeat,poll,result,version,download},gpu-fleet(+ocr-version,ollama-versions),gpu-reset,role-assignments(+sync),mode-catalog,host-provisioning}` | |

### 3.2 Data

| Store | Model / key | Line |
|---|---|---|
| Prisma (system.db) | `SidecarCommand` | `prisma/schema.prisma:471` |
| Prisma (system.db) | `HostProvisioning` (`sidecarUrl @unique`, `hostOsOverride`, `masterUrlForHost`, `masterWsPortForHost`) | `:494` |
| Prisma (system.db) | `HostRoleAssignment` (`sidecarUrl+mode` unique, `enabled`, `minOnline`, `idleTimeoutMin`, `modelOverride`, `runtime`) | `:511` |
| Prisma (system.db) | `ModelDownload`, `AdminUser` | `:200`, `:807` |
| Config (per profile!) | `gpu.sidecars` (fleet list), model per mode, OpenRouter key, GPU mem utils | `fleet-router.ts:407-419`, `mode-catalog-server.ts:55` |
| Routing | `src/lib/db/prisma.ts:115` `SYSTEM_MODELS` | |

The "RoleType" table was removed (`role-registry.ts:1-15`). "Mode Types" is now the fixed catalog
in `mode-catalog.ts`. Note: `gpu.sidecars` sits in per-profile `Config`, not in `system.db` — a known
gap from task 56 ("Open").

### 3.3 Dependencies on Sound Suite internals

- `@/lib/db/config` (`getConfig`, `setConfigValue`) — fleet list, models, OpenRouter, GPU weights.
- `@/lib/db/prisma` profile proxy and `SYSTEM_MODELS`.
- `@/lib/logger`, Redis client (status keys `soundsuite:*`).
- `resolveEndpoint` callers inside Sound Suite: `lib/ingestion/ollama-embedding-provider.ts`,
  `ollama-ocr-engine.ts`, `lib/ai/ai-provider.ts`, `lib/ai/stream-rlm.ts`,
  `lib/search/reranker-lifecycle.ts`, `lib/mcp/shared-dependencies.ts`.
- Admin auth (`AdminUser`, session) and the admin shell layout.

### 3.4 Sidecar side (`sideCar/`)

- Masters: `sideCar/src/lib/config.ts:19` `MasterEntry {serverUrl, authToken?, wsPort?}`; `state.ts:858-938` `MasterConnection`, `ensureMaster`.
- Dial: `sideCar/src/lib/ws-client.ts:1297-1298` — `ws://${serverHost}:${wsPort ?? 3002}/sidecar`. **No wss.**
- `wsPort` only arrives in a `master-identity` frame (`ws-client.ts:1489-1561`).
- Bearer `authToken` sent on HTTP (`ws-client.ts:245,1364`).
- Commands: `ws-client.ts:369-858` (`acquire`, `release`, `start`, `stop`, `status`, `config`, `update`, `pullModel`, …).
- `/api/masters` GET/POST/DELETE (multi-master refactor).

### 3.5 Other masters

| App | Master address | WS port | Notes |
|---|---|---|---|
| Sound Suite | `soundsuite.vpn.bas.co` | 3002 | full master |
| Fantom | `fantom.vpn.bas.co` | 3003 | `mcpfantom/src/sidecars/soundsuiteMaster.ts` re-implements the protocol; issues no commands, uses HTTP to sidecar |
| QuickBooks | `qbmcpserver.vpn.bas.co` | 3005 | needs `SIDECAR_AUTH_TOKEN` |
| Spam filter | `100.114.83.26:8265` | 3004 | plain http |
| Axon | — | none | no WS relay |

Masters are pushed by `scripts/configure-sidecar-masters-netbird.sh` (241 lines: per-host
`wsPort` table, GET/PATCH/POST `/api/masters`) and removed by `configure-sidecar-delete-masters.sh`.

---

## 4. Target architecture

```
                      operators (browser, NetBird)
                                 │ https
                ┌────────────────▼─────────────────┐
                │ sidecarmaster.vpn.bas.co (basws42)│
                │  sidecarmaster-caddy  :443 ──┐    │  Cloudflare DNS-01
                │  sidecarmaster-netbird       │    │
                │  sidecarmaster (Next.js)     ▼    │
                │   ├ UI: Fleet, Hosts, Apps, Roles, Alerts, Settings(NetBird/HTTPS)
                │   ├ /sidecar  (WS, sidecars)   /api/v1/* (apps, REST + SSE)
                │   ├ app registry · host registry · desired state
                │   ├ command queue · status cache · alert engine
                │   └ SQLite (Prisma) + optional Redis
                └───▲────────────────▲──────────────▲──┘
        wss /sidecar│      REST/SSE  │ app token    │ REST/SSE
   ┌────────────────┴───┐   ┌────────┴──────┐  ┌────┴─────────┐
   │ management sidecars│   │ Sound Suite   │  │ Fantom, QB,  │
   │ BASWS34/35/41,     │   │ (follower or  │  │ spam, Axon,  │
   │ Mac-mini, mcpserver│   │  own master)  │  │ ExpeDat …    │
   └────────┬───────────┘   └───────────────┘  └──────────────┘
            │ wss /sidecar (app masters handed out by sidecarmaster)
            └──────────► soundsuite / fantom / qbmcp / spam  (as today)
```

Key rules:

1. **sidecarmaster is the bootstrap.** A sidecar needs one address: `https://sidecarmaster.vpn.bas.co`
   plus a join token. Everything else (app masters, ports, tokens, policy) comes from it.
2. **Desired state lives in sidecarmaster.** Host → app → roles → runtime/model/limits. It pushes it
   and corrects drift.
3. **Apps keep their own data path.** An app still calls the sidecar (or its own WS link) for
   `acquire`/`virtual-embed`. sidecarmaster is not on the hot path of an inference request.
4. **Two ways for an app to use the fleet** (§8): *direct* (app stays a master on the sidecar, as
   today) or *via sidecarmaster API* (app asks sidecarmaster for an endpoint).

### 4.1 Repo layout (`/Users/alper/Code/sidecarmaster`)

```
sidecarmaster/
  src/app/            Next.js App Router: /fleet /hosts /apps /roles /alerts /settings
  src/app/api/v1/     REST for apps + sidecar HTTP fallback
  src/lib/relay/      WS server (from ws-relay.ts), command queue, status cache
  src/lib/fleet/      desired state, reconcile loop, min-online, drift
  src/lib/apps/       app registry, mode catalogs per app
  src/lib/alerts/     rules, notifiers
  src/lib/protocol/   shared frame types (published as @sidecarmaster/protocol)
  prisma/schema.prisma
  docker/{Dockerfile,entrypoint.sh,netbird-entrypoint.sh,caddy-entrypoint.sh,caddy.Dockerfile}
  docker-compose.yml
  docs/{design.md,tasks.md}  (copied from this spec when the repo is created)
```

Stack: Next.js + Prisma + SQLite, same as Sound Suite, so code moves with few changes. Redis is
optional (only for multi-replica later).

---

## 5. Data model and migration

### 5.1 New Prisma models (sidecarmaster)

| Model | Key fields | Replaces |
|---|---|---|
| `Host` | `id` (cuid, stable), `name`, `os`, `hostOsOverride`, `agentUrl` (last seen), `peerAddress`, `netbirdIp`, `joinedAt`, `lastHeartbeatAt`, `sidecarVersion`, `labels` JSON, `note` | `gpu.sidecars` Config + `HostProvisioning` |
| `HostCredential` | `hostId`, `tokenHash` (Argon2id), `createdAt`, `revokedAt` | new |
| `App` | `id` (`soundsuite`, `fantom`, `axon`, `quickbooks`, `expedat`, `spam`, …), `displayName`, `masterUrl` (https), `wsUrl` (wss or null), `protocol` (`ss-v1`/`none`), `enabled`, `apiTokenHash` | `configure-sidecar-masters` tables |
| `AppMode` | `appId`, `name` (e.g. `ss-embedding`), `image`, `port`, `requiresGpu`, `vramMb`, `runtimes[]`, `env` JSON, `defaultModel` per OS | `mode-catalog.ts` (Sound Suite becomes one app's catalog) |
| `HostApp` | `hostId`, `appId`, `enabled`, `masterUrlOverride`, `wsPortOverride`, `authTokenRef` | `HostProvisioning.masterUrlForHost/masterWsPortForHost` |
| `RoleAssignment` | `hostId`, `appId`, `mode`, `enabled`, `minOnline`, `idleTimeoutMin`, `modelOverride`, `runtime` | `HostRoleAssignment` (now keyed by `hostId`, not URL) |
| `Command` | as `SidecarCommand`, plus `hostId`, `appId`, `requestedBy` | `SidecarCommand` |
| `HeartbeatSample` | `hostId`, `at`, `gpus` JSON, `containers` JSON, `activeRequests`, `errors` | new (ring, 7 days) |
| `Alert` / `AlertRule` | `kind`, `hostId?`, `appId?`, `state`, `firstAt`, `lastAt`, `ackBy` | new |
| `AuditLog` | who, what, before/after | new |
| `AdminUser`, `Setting` | | own copies (no shared login) |

Secrets (`App.apiToken`, per-app sidecar tokens, Cloudflare token, NetBird setup key) are stored
encrypted (AES-256-GCM, key from env `SM_SECRET_KEY`), shown masked (last 4), never logged.

### 5.2 Why `hostId`

Tasks 41/43/44 show a URL is not a stable key. The sidecar gets a `hostId` on first join and saves
it. Address changes update `Host.agentUrl` only; rows stay attached.

### 5.3 Migration from Sound Suite

One-shot importer `sidecarmaster import-soundsuite --system-db <path> --config-db <path> [--dry-run]`:

1. Read `data/system.db`: `HostProvisioning`, `HostRoleAssignment`, open `SidecarCommand` (skip expired).
2. Read active profile's `Config`: `gpu.sidecars`, per-mode model keys, GPU mem utils, OpenRouter
   (copy key only if the operator says yes — Q6).
3. Create a `Host` per distinct `sidecarUrl` (merge by hostname when two URLs are the same box, e.g.
   after DHCP moves — report, do not guess silently).
4. Create `App` rows: `soundsuite`, `fantom`, `quickbooks`, `spam` from the table in
   `configure-sidecar-masters-netbird.sh`; `axon`, `expedat` with `protocol: none`.
5. Map `HostRoleAssignment` → `RoleAssignment(appId='soundsuite')`.
6. Print a diff report. Re-runnable (upsert by natural keys). Sound Suite DB is only **read**.

---

## 6. Sidecar protocol changes

Today: the sidecar keeps a manual list of masters and dials `ws://host:wsPort/sidecar`.

### 6.1 New: bootstrap + `masters` frame (protocol v2)

1. **Join.** Sidecar env/config: `SIDECARMASTER_URL=https://sidecarmaster.vpn.bas.co` and
   `SIDECARMASTER_JOIN_TOKEN` (one-time). First boot: `POST /api/v1/hosts/join {hostname, os, version, joinToken}`
   → `{hostId, hostToken}`. Sidecar saves both in `/app/config` (0600). Join token is single-use, 24 h.
   Option: operator approves pending joins in the UI (Q3).
2. **Connect.** `wss://sidecarmaster.vpn.bas.co/sidecar` with `Authorization: Bearer <hostToken>`
   and `X-Sidecar-Protocol: 2`. Same `register`/`heartbeat`/`result`/`command` frames as today.
3. **Masters frame.** After `registered`, sidecarmaster sends:
   ```json
   { "type": "masters", "rev": 42,
     "masters": [ { "appId": "soundsuite", "serverUrl": "https://soundsuite.vpn.bas.co",
                    "wsUrl": "wss://soundsuite.vpn.bas.co/sidecar", "authToken": "…", "managed": true } ] }
   ```
   The sidecar **diffs** by `appId`: adds new, updates changed in place (no rekey — task 42), removes
   `managed: true` entries that are gone. Entries the operator added by hand are `managed: false`
   and never touched. Sidecar answers `{type:'masters-ack', rev}`.
4. **Desired policy.** `config` frames from sidecarmaster carry the per-app role set. The sidecar
   namespaces `idleTimeouts`/`minOnline`/`registry` by `appId` (the v2 item in
   `sidecar-multimaster-changes.md`). App masters may still push `config`; for modes owned by
   sidecarmaster the sidecar keeps sidecarmaster's value and reports the conflict in heartbeat.
5. **wss.** `MasterEntry` gets `wsUrl`. If set, dial it as is (`wss://…/sidecar` through Caddy on 443).
   If not set, keep the old `ws://host:wsPort` rule. Each app's Caddy adds a route
   `/sidecar → 127.0.0.1:<wsPort>` (Caddy proxies WS upgrades by default).

### 6.2 Drift healing

- Heartbeat carries `mastersRev`, `masters[].{appId, connected, lastError}`, running containers,
  `policyRev`.
- Reconcile loop (30 s): if `mastersRev` < current → resend `masters`; if containers differ from
  desired → queue `provision`/`start`/`stop`; if a sidecar version is too old → mark "needs update"
  (operator presses Update; no silent auto-update in v1, Q4).
- Address drift: sidecarmaster stores the **observed** peer address (task 44) and pushes
  `agentUrl` corrections in `config`.
- Every heal action is written to `AuditLog` and shown on the host page.

### 6.3 Migration for sidecars in the field

| Step | What | Old sidecars |
|---|---|---|
| M0 | sidecarmaster runs and **speaks protocol v1** at `wss://sidecarmaster…/sidecar` and `ws://<netbird-ip>:3010/sidecar`. | Work with no change. |
| M1 | Run the old script **one last time** to add sidecarmaster as a master on every sidecar (`SIDECARMASTER_MASTER_URL`). | Now connected; sidecarmaster can see and command them. |
| M2 | Ship sidecar ≥ 2.5 (protocol v2: `masters` frame, `wsUrl`, `hostId`, per-app namespacing). sidecarmaster pushes `update` per host from the UI. A v1 sidecar that connects gets a `hostId` minted from its URL (adoption). | v1 still served by v1 path. |
| M3 | v2 sidecars receive `masters`; existing hand entries are matched by URL and marked `managed`. Turn on drift healing per host (switch on host page). | — |
| M4 | All hosts on v2 for 2 weeks → delete `configure-sidecar-masters*.sh` (keep in git history). | — |

Rollback: unset `managed` (UI switch "freeze masters") → sidecar keeps its current list and stops
applying `masters` frames. The old script still works because `/api/masters` stays.

---

## 7. App registry and provisioning for all apps

- **App** = a thing that may run containers on hosts and/or be a master. Fields in §5.1.
- **AppMode** = one container recipe: image, port, env, GPU need, runtimes, per-OS default model.
  Sound Suite's 7 modes (`mode-catalog.ts:71-118`) become `AppMode` rows of `soundsuite`. Fantom's
  `code-embedding` becomes `fantom` modes (today it borrows `ss-code-embedding`; Q7).
- Sidecar change: `mode-templates.ts` resolves a mode from the catalog it **receives** (`registry`
  in `config`), not only from its built-in table. Built-in Sound Suite templates stay as fallback.
- **Port plan.** sidecarmaster owns a port map per host and refuses two modes on one port.
- **Env per app.** `AppMode.env` with `{{secret:name}}` refs resolved at push time; secrets stored
  encrypted; never shown in full.
- **Provisioning Docker on hosts.** Two levels:
  1. *Containers via the sidecar* (now): `provision` / `start` / `stop` / `pullModel` commands.
  2. *Whole app stacks* (later, phase 5): sidecar gets `stack.apply {appId, composeYaml, envRef}`
     → runs `docker compose -p <appId> up -d` in its data dir. Needs the Docker socket (it has it)
     and a strict allow-list of images per app. This is how ExpeDat/Axon stacks on basws42 could be
     deployed without RDP.
- **Apps with no WS relay** (Axon, ExpeDat): listed as apps for provisioning and health only
  (`protocol: none`); health through an HTTP probe URL in the registry.

---

## 8. How Sound Suite follows sidecarmaster

Setting `fleet.source` in Sound Suite (Admin → **Sidecar master** tab; env `SS_FLEET_SOURCE` overrides it; how-to in `docs/sidecarmaster-fleet-source.md`):

| Value | Meaning |
|---|---|
| `local` (default today) | Exactly as now. Sound Suite's own tables and pages. |
| `follow` | Sound Suite **reads** desired state and fleet status from sidecarmaster (`GET /api/v1/apps/soundsuite/fleet`, SSE `/api/v1/events?app=soundsuite`). Its relay on 3002 stays on, so sidecars still connect to it as an app master and `acquire`/`virtual-embed` keep their low latency. Local `HostRoleAssignment` writes are blocked; the four admin tabs show read-only data with a link "Edit in sidecarmaster". `resolveEndpoint` uses the followed status. |
| `secondary` (not recommended) | Sound Suite keeps writing locally and two-way syncs. Rejected: two writers re-create the "last writer wins" problem. Listed only to say why not. |

Chosen design: **client/consumer (`follow`)**, not a syncing second master. Reasons: one writer,
no conflict rules, Sound Suite keeps working if sidecarmaster is down (it keeps the last snapshot,
cached in `system.db` table `FleetSnapshot`, and its sockets to sidecars are unaffected).

Code impact in Sound Suite (small, behind the switch):
- `src/lib/db/fleet-source.ts` (new): settings, master client, snapshot in `FleetSnapshot`, gates. `src/lib/gpu/fleet-follower.ts` (new): poll + SSE loop.
- `role-registry.ts` returns sidecarmaster's rows; `fleet-router.ts`, `ws-relay.ts` and the watchdogs skip config pushes, master-URL reassert, min-online and container control. Routing (`resolveEndpoint`) is unchanged.
- In `follow` mode the min-online tick is a no-op — sidecarmaster does it.
- Admin tabs GPU Fleet, Mode Types, Role Assignments, Host Provisioning get a read-only banner with a link to sidecarmaster and disabled controls; their write routes answer `409 FOLLOWING_SIDECARMASTER`.

Other apps (Fantom, QuickBooks, spam) use the same REST/SSE API when they need fleet data. Fantom
can then drop most of its own registry (`mcpfantom/src/sidecars/registry.ts`) later — optional.

---

## 9. NetBird and HTTPS

Same model as `fileSystemSideCar/docs/https-netbird.md` and `mcpfantom/docker/{netbird,caddy}-entrypoint.sh`:

- Stack on basws42: `C:\sidecar-deploy\sidecarmaster\` with `sidecarmaster`, `sidecarmaster-netbird`,
  `sidecarmaster-caddy` (all `network_mode: service:sidecarmaster`).
- NetBird name `sidecarmaster` → `https://sidecarmaster.vpn.bas.co`.
- Settings page: NetBird tab (setup key, hostname, management URL, WireGuard port under Advanced)
  and HTTPS part (on/off, domain `vpn.bas.co`, Cloudflare token masked, cert status). Writes
  `/netbird-ctl/config.json` (0600). Reads `status.json`, `caddy-status.json`. Copy the help table
  for the Cloudflare token.
- Caddyfile: `/sidecar*` → `127.0.0.1:<wsPort>` (or same port if the WS server shares the HTTP
  server — preferred: one port, `server.on('upgrade')`), everything else → `127.0.0.1:3000`.
- The NetBird setup key and Cloudflare token are entered by the user in Settings. Not in env, not in git.

Each app master that wants `wss` adds the `/sidecar` route to its own Caddy (one line per app, Task 3.4).

---

## 10. Security

| Link | Auth |
|---|---|
| Sidecar → sidecarmaster | Per-host token from join (Bearer on WS upgrade + HTTP). Stored hashed (Argon2id). Revoke per host. Only over NetBird + TLS. |
| sidecarmaster → sidecar commands | Only on the socket the sidecar opened. No inbound port needed. |
| Sidecar → app masters | Per-app token handed out in the `masters` frame (e.g. QuickBooks `SIDECAR_AUTH_TOKEN`). The script's ssh read of `/srv/qbmcp/env/app.env` is replaced by storing the token once in the app registry. |
| App → sidecarmaster API | Per-app API token (scopes: `fleet:read`, `fleet:write`, `commands`). Sound Suite `follow` needs `fleet:read` only. |
| Operator → UI | Own `AdminUser` login (Argon2id), sessions, optional NetBird-only bind. Audit log for every write. |
| Sidecar local API (`/api/masters`, `/api/*`) | Today open with CORS `*`. v2: require the host token or local-only for writes (the v2 item from the multi-master report). |

No secret is ever logged or returned in full. Join tokens are single-use. The `masters` frame carries
tokens only over TLS; on `ws://` fallback (M0/M1) it sends no tokens.

---

## 11. Dashboard and monitoring

Pages:

1. **Fleet overview** — grid: hosts × apps. Cell = state (running / starting / stopped / error /
   unknown) + role names. Top bar: hosts up/down, apps healthy, open alerts.
2. **Host page** — OS, sidecar version, uptime, last heartbeat age, NetBird IP, observed address,
   GPUs (name, VRAM used/total, util %), containers (image, port, model, state, restarts),
   active requests per role, masters list with connected/last error, drift status, recent commands,
   actions: restart sidecar (task 45), update, provision, freeze masters.
3. **App page** — where it runs, each mode's instances, jobs/active requests, version, health probe,
   errors in the last 24 h, its master link status from every host.
4. **Roles** — today's Role Assignments grid, now per app (moved `admin-role-assignments.tsx`).
5. **Alerts** — list, ack, mute.
6. **Settings** — NetBird, HTTPS, users, app tokens, alert channels.

Data: heartbeats (5 s) update a live status cache; a sample every 60 s goes to `HeartbeatSample`
(7-day ring). UI updates by SSE.

Alert rules (v1):
- Host heartbeat older than 60 s → `host-down` (critical after 5 min).
- App master not connected from a host where it is enabled for > 2 min.
- Desired container not running for > 5 min, or > 3 restarts in 10 min.
- GPU VRAM > 95 % for 10 min; disk < 10 % (if the sidecar reports it).
- Sidecar version below minimum; masters drift not healed after 3 tries.
- `activeRequests` above a cap for 10 min (link to task 40; also catches the counter leak in
  `sidecar-remediation-2026-09-15.md` §1).

Notify: in-UI, email (SMTP), optional webhook (Slack/ntfy). Optional `/metrics` (Prometheus format)
so Grafana can be added later without code change.

---

## 12. Open-source options (reuse?)

| Tool | Does | Reuse? |
|---|---|---|
| Portainer (+ Edge Agent) | Docker host UI, agents dial out | No — no GPU roles or app masters; heavy; could sit beside for raw Docker views. |
| Komodo / Dockge | Compose stack deploy across hosts | Maybe later for phase 5 stack deploy; not for roles. |
| HashiCorp Nomad / Consul | Scheduler / service registry | No — too much new infra for 5 hosts. |
| Kubernetes / k3s + GPU operator | Full orchestration | No — Windows/Mac hosts, Ollama native on Mac. |
| Uptime Kuma | Health checks, alerts | Optional add-on for external probes; our alerts need heartbeat data. |
| Prometheus + Grafana + DCGM exporter | Metrics, GPU charts | Optional: expose `/metrics`; do not depend on it in v1. |
| Watchtower | Auto-update images | No — updates must be operator-driven (Q4). |
| NetBird + Caddy (`caddy-dns/cloudflare`) | Network + TLS | Yes — already the house pattern. |

Decision: build sidecarmaster by moving existing code; no new platform dependency.

---

## 13. Rollout and rollback

| Phase | Rollout | Rollback |
|---|---|---|
| 1 Service shell | Deploy stack on basws42; no sidecar talks to it. | `docker compose down`. |
| 2 Import + read-only | Import from Sound Suite; v1 protocol; add as extra master by script (M1). | Remove master with delete script. Sound Suite untouched. |
| 3 Control | sidecarmaster writes roles; Sound Suite `fleet.source=follow`. | Set `fleet.source=local`; Sound Suite keeps its own tables (never deleted). |
| 4 Auto masters | Sidecar v2 rollout one host at a time (Mac-mini first). | "Freeze masters" per host, or pin sidecar image back. |
| 5 Retire scripts / stacks | Delete scripts after 2 weeks clean. | Restore from git. |

Sound Suite's master code and tables stay in place in every phase.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| sidecarmaster down → no control | Sidecars keep last config and app masters; apps keep routing on last snapshot. Alerts from a second watcher (Uptime Kuma) optional. |
| Two writers (Sound Suite local + sidecarmaster) | `follow` blocks local writes; sidecar namespaces policy by `appId` and reports conflicts. |
| Reconnect loops (tasks 42/46) | Diff-based `masters` frame, no rekey; copy superseded-socket grace; tests from `sidecar-master-rekey.test.ts`. |
| `wss` behind Caddy breaks long sockets | Caddy keeps WS; set `read_timeout` off for `/sidecar`; ping every 25 s. |
| Token leak through `masters` frame | TLS only; per-app tokens; rotate from UI. |
| `sideCar/` is public | No real addresses or tokens in sidecar code or tests. |
| Fantom's own protocol copy drifts | Shared `@sidecarmaster/protocol` package with golden JSON fixtures. |
| Profile split leftovers (`gpu.sidecars` in per-profile Config) | Importer reads the active profile and reports differences across profiles. |

---

## 15. Open questions for the user

1. Repo path `/Users/alper/Code/sidecarmaster` and GitLab `alperu/sidecarmaster` — OK?
2. Stack: Next.js + Prisma + SQLite (fast to move code) — OK, or do you want Rust like the fileSystem sidecar?
3. Host join: auto-accept with a join token, or operator approves each new host?
4. Sidecar updates: operator button only, or auto-update during a time window?
5. Should Sound Suite in `follow` mode still accept sidecar sockets on 3002 (keeps low latency), or should all commands go through sidecarmaster?
6. Copy the OpenRouter key into sidecarmaster (it pushes it to sidecars today via `buildOpenRouterPush`, `fleet-router.ts:973`), or keep it per app?
7. Fantom `code-embedding`: its own app mode, or keep sharing `ss-code-embedding`?
8. Phase 5 stack deploy (sidecar runs `docker compose` for whole apps): wanted now, or later?
9. Alert channels: email, Slack, ntfy, or another?
10. Spam filter is plain `http://100.114.83.26:8265`: give it a NetBird name + Caddy (`spam.vpn.bas.co`)?
11. Does the dashboard need read access for non-admin users?

## 16. Decisions (2026-10-30)

Answers from the user to the questions in section 15.

| # | Question | Decision |
|---|---|---|
| 1 | Repo name and path | Yes: `/Users/alper/Code/sidecarmaster`. |
| 2 | Next.js or Rust | Next.js. No change of technology. |
| 3 | Host join: token or approval | Join with a token, no manual approval. |
| 4 | Sidecar updates: manual or in a window | Automatic updates. |
| 5 | Sidecars still dial Sound Suite on 3002 in `follow` mode | Yes. Sound Suite keeps routing its own work. |
| 6 | OpenRouter key | Each app keeps its own key. |
| 7 | Fantom code embedding | Fantom gets its own mode. |
| 8 | Stack deploy | Later, in phase 6. |
| 9 | Alert channels | Email over SMTP. Admin sets the SMTP server, port, TLS, user, password (masked, last 4) and recipients in Settings, with a "send test email" button. |
| 10 | Spam filter NetBird name + HTTPS | Yes (`spam.vpn.bas.co`). |
| 11 | Dashboard access | Admins only, with username and password on the sidecarmaster instance. No read-only role. |
