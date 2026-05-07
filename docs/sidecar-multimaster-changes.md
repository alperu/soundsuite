# Sidecar Multi-Master Refactor — Change Report

**Date:** 2026-05-07
**Branch:** `worktree-agent-a183fd38919281deb` (worktree at `.claude/worktrees/agent-a183fd38919281deb/`)
**Status:** uncommitted, pending review.
**Diff stat:** 547 insertions / 344 deletions across 9 modified files + 2 new route files.

## Goal

Today the sidecar binds to exactly one master via a single `state.serverUrl`.
Make it speak to N masters concurrently. Court-lens master pushes are
unchanged — from each master's POV it's still the only one talking to a 1:1
sidecar. The sidecar fans out registration/heartbeats and never lets one
master clobber another's slot. Multi-master is the release default; no
feature flag.

## Scope boundary

**Sidecar only.** No edits to court-lens master code or fantom-mcp. The
existing wire format (`register` / `heartbeat` / `result` / `command` /
`config` frames) is preserved bit-for-bit for each master independently.

## Files changed

| File | Lines (±) | Summary |
|---|---|---|
| `sideCar/src/lib/state.ts` | +100 −6 | Added `MasterConnection` + `PendingCommand` types; replaced single `wsConnection`/`wsReconnectTimer`/`wsReconnectDelay`/`wsHeartbeatTimer` with `state.masters: Map<serverUrl, MasterConnection>`. Helpers: `ensureMaster`, `removeMaster`, `getMaster`, `rekeyMaster`, `legacyServerUrl`, `syncLegacyServerUrl`. Legacy `serverUrl`/`savedAgentUrl`/`connectionStatus`/`wsCommandCount` kept for back-compat reads (self-update, env-bootstrap, /api/status). |
| `sideCar/src/lib/ws-client.ts` | +278 −218 | Rewritten around a per-master loop. New per-master functions: `connectMaster`, `disconnectMaster`, `scheduleReconnect`, `sendHttpHeartbeat`, `pollForCommands`, `processCommand`, `reportResult`, `sendRegister`. New fan-out wrappers: `connectAllMasters`, `disconnectAllMasters`. Module-level `pendingCommands`/`heartbeatTimer`/`pollTimer`/`connectionMode` removed — moved onto `MasterConnection`. `executeCommand(m, cmd)` now takes the master so `update`/`config` actions act on the right slot. `applyConfig(m, payload)` rekeys ONLY the targeting master's slot when `serverUrl` changes (never adds a second master, never overwrites another). Update-check runs once against the first master only — the binary doesn't need N parallel update probes. `httpPost` accepts optional `authToken`. Legacy shims `connectWebSocket()`/`disconnectWebSocket()` kept for any straggler callers. |
| `sideCar/src/lib/config.ts` | +83 −29 | `loadSavedConfig` now merges masters from four sources, deduping by `serverUrl` in insertion order: `data.masters[]` (canonical, items can be string or `{serverUrl, authToken}`), legacy `data.serverUrl`, `sidecar.config.json#serverUrl`, env `SIDECAR_MASTERS` (comma list), env `SOUND_SUITE_MASTER_URL` / `SERVER_URL`. Populates `state.masters` and calls `syncLegacyServerUrl()`. `saveConfig` writes back `{masters: [{serverUrl, authToken?}], serverUrl: <first master>, …}` so legacy parsers still work; mirrors first URL into `sidecar.config.json` for warm-start. |
| `sideCar/src/instrumentation.ts` | +? −? | Drops the single-URL bootstrap (now done inside `loadSavedConfig`). Kicks off the gossip client when `state.masters.size > 0`. |
| `sideCar/src/lib/handlers.ts` | +? −? | `handleStatus()` derives `wsConnected` from "any master on WS"; adds `masters: [{serverUrl, connectionMode, lastHeartbeatAt, lastSeenServerVersion, pendingCommandCount}]` while keeping legacy `serverUrl`. Includes `lastConfigPushAt` in the status payload (used by court-lens UI's policy-override warning). |
| `sideCar/src/app/api/ws-connect/route.ts` | rewrite | Additive: `ensureMaster` + `connectMaster` (idempotent). No longer wipes other masters. Persists via `saveConfig()`. |
| `sideCar/src/app/api/ws-disconnect/route.ts` | rewrite | Body `{serverUrl?}`. Targeted removal if present (404 if unknown). Empty body → legacy "wipe all" semantics for back-compat with operators who hit the route with no payload. |
| `sideCar/src/app/api/status/route.ts` | rewrite | POST `connect`/`disconnect` now act per-master (additive connect; optional `serverUrl` on disconnect). |
| `sideCar/package-lock.json` | minor | unrelated dep refresh from npm install. |

## New files

| File | Purpose |
|---|---|
| `sideCar/src/app/api/masters/route.ts` | `GET` returns `{masters: [{serverUrl, connectionMode, lastHeartbeatAt, lastSeenServerVersion}]}`. `POST {serverUrl, authToken?}` is idempotent — adds + connects, returns the entry. |
| `sideCar/src/app/api/masters/[serverUrl]/route.ts` | `DELETE` decodes the URL segment, `disconnectMaster()`, `removeMaster()`, persists via `saveConfig()`, returns `{ok, removed}` or 404. |

## Wire format — explicit guarantees

For each master the sidecar talks to, the frames are bit-identical to the
single-master era. From court-lens's POV nothing changed:

- **Sidecar → master** still sends `{type:'register', agentUrl, hostname, containers}` once on WS open, `{type:'heartbeat', containers, activeRequests, statusData:{…, masters:[…], lastConfigPushAt}}` every 5s, `{type:'result', id, …}` on command completion. `statusData` is now ENRICHED with `masters[]` and `lastConfigPushAt` — old masters that don't read those fields are unaffected.
- **Master → sidecar** still sends `{type:'registered'}`, `{type:'command', id, action, payload}`, `{type:'config', payload:{…}}`. Config push handling on the sidecar is now slot-scoped (see below).

HTTP fallback URLs unchanged: `${master.serverUrl}/api/admin/gpu/sidecars/{heartbeat,poll,result}` per master.

## `applyConfig` — additive semantics

The most subtle behavior change. Previously a `config` push could overwrite
the singleton `state.serverUrl`. Now:

- The push targets ONLY the master that sent it (the WS that received the frame).
- If `payload.serverUrl !== m.serverUrl`, `rekeyMaster(oldUrl, newUrl)` re-keys
  the Map entry without touching other masters.
- `idleTimeouts`, `minOnline`, `registry` keep mutating the SHARED state
  (intentional v1 limitation — comment in the source flags this for v2
  namespacing). Court-lens and Fantom both win-by-recency on these.

## Module-level singletons that became per-master

Per the inventory done before implementation:

- `pendingCommands` (was module-global) → `MasterConnection.pendingCommands`. So a `result` frame from master A can never resolve a promise queued by master B.
- `connectionMode` → `MasterConnection.connectionMode`. Each master flips between `websocket` and `http` independently.
- `wsReconnectTimer` / `wsReconnectDelay` → per-master.
- `heartbeatTimer` / `pollTimer` → per-master.
- `httpHeartbeatFailCount` / `wsHeartbeatFailCount` → per-master.

## Module-level singletons that stayed shared

The GPU/container layer is master-agnostic by design:

- `state.perRole` (active-request counters), `state.peakDemand`, `state.modelLoading`, `state.activeRequests`, `state.idleTimeouts`, `state.minOnline`, `state.registry`, `state.currentMode`, `state.startedAt`, `state.gpuCache`, `state.lastConfigPushAt`, `tasks` (from task-tracker).

These remain shared so two masters commanding the same sidecar still serialize through the existing role locks. Last-writer-wins on policy fields is the v1 trade-off; v2 will namespace per-master.

## Acceptance scenarios (traced through code)

1. **Single-master legacy config** (`{serverUrl: "http://172.16.16.9:3000/"}`): `parseMastersField` returns `[]` → legacy field feeds `addMaster()` → one entry → `connectAllMasters()` connects it → behavior identical to today.
2. **Two-master config** (`{masters: ["http://172.16.16.9:3000/", "http://localhost:3848/"]}`): two `MasterConnection` slots → `connectAllMasters()` opens two parallel WS attempts → each gets its own `register` frame.
3. **WS to A killed**: `m_A.heartbeatTimer` cleared, `scheduleReconnect(m_A)` only; `m_B`'s timers untouched.
4. **`applyConfig` rename from A**: `rekeyMaster(oldUrl_A, newUrl_A)` deletes A's old key, re-inserts the same `MasterConnection` instance under the new key. B not iterated.
5. **`GET /api/masters`** lists both. **`DELETE /api/masters/<encoded-A>`** removes A only.
6. **`/api/status`** carries `masters: [...]` plus the legacy `wsConnected` boolean (`true` if any master is on WS).
7. **`tsc --noEmit`** from `sideCar/` — clean. **`next lint`** — clean (only Next 16 deprecation banner + unrelated pre-existing circular-JSON warning).

## v1 limitations (called out inline in code)

- **Shared `idleTimeouts` / `minOnline` / `registry`.** A config push from any master mutates the shared GPU/container layer; last-writer-wins. Documented at the `case 'config'` in `executeCommand`. Court-lens UI now surfaces this via the "policy overridden" badge (separate court-lens diff).
- **Update check runs against first master only.** Avoids N-fold update probes; documented inline.
- **No bearer auth on `/api/masters` yet.** Same posture as the rest of `/api/*` — open with `Access-Control-Allow-Origin: *`. v2 work.

## Court-lens companion changes

These live on `main` (uncommitted) and are dependent on the sidecar wire-format additions:

- `src/lib/gpu/fleet-router.ts` — drop `serverUrl` from `pushFullConfig` payload (no longer needed); `markSelfConfigPush(agentUrl)` stamps `selfLastConfigPushAt` after every successful push.
- `src/lib/gpu/status-cache.ts` — `CachedSidecarStatus` adds `masters[]`, `lastConfigPushAt`, `selfLastConfigPushAt`; threaded through `updateSidecarStatus`.
- `src/app/api/admin/gpu/sidecars/heartbeat/route.ts` — extracts `body.masters` and `body.lastConfigPushAt`.
- `src/lib/gpu/ws-relay.ts` — same fields extracted from WS heartbeat path.
- `src/components/admin-gpu-fleet.tsx` — orange "shared ×N" badge (with tooltip) when multiple masters serve a sidecar; yellow "policy overridden" badge when another master pushed config more recently than Sound Suite.

## What remains for v2

1. Per-master namespacing of `idleTimeouts` / `minOnline` / `registry` so two masters don't collide.
2. Bearer-token auth on `/api/masters` (and optionally on existing `/api/*`).
3. mTLS / OAuth if required.
4. Idle-timeout precedence rule (spec recommendation: `max` across active masters so no master's expectations are broken by another's tighter timer).
5. Status fan-out scoping (per-master view vs global) — left as global for v1 simplicity.
6. Fantom MCP master surface — Fantom currently uses HTTP-REST against the sidecar's `/start`/`/acquire`/`/stop` endpoints (no register/heartbeat). To act as a Sound Suite-style master it would need its own WS relay + register/heartbeat handler. Out of scope for the sidecar refactor itself.
