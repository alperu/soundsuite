/**
 * Gossip Client — Sidecar ↔ Server Communication (multi-master)
 *
 * The sidecar maintains an independent connection to N masters concurrently.
 * Each MasterConnection owns its WebSocket, heartbeat timer, HTTP-poll timer,
 * pendingCommands map, and reconnect backoff. Masters are key'd by serverUrl
 * in state.masters.
 *
 * Wire format is unchanged — each master sees the same register/heartbeat/
 * result frames it saw in the single-master era; from each master's POV
 * nothing has changed.
 *
 * NOTE on shared state: registry/idleTimeouts/minOnline/perRole/peakDemand
 * remain SHARED across masters. A config-push from any master mutates the
 * shared GPU/container layer — needs namespacing later but kept simple for v1.
 */

import os from 'os';
import http from 'http';
import https from 'https';
import WebSocket from 'ws';
import { state, dockerSupportsGpu, ensureMaster, rekeyMaster, removeMaster, ensureSet, type MasterConnection } from './state';
import { handleAcquire, handleRelease, handleResetCounters, handleStart, handleStop, handleStatus, handlePullModel, handleLoadModel, getTotalActiveRequests } from './handlers';
import { switchMode, provisionContainers, getAllContainerStates, containersForMode } from './containers';
import { discoverGpus } from './gpu';
import { getContainerState, pullImage, createContainer, startContainer, dockerRequest, getDockerHostName } from './docker';
import { ollamaList, ollamaPull, ollamaLoad, waitForOllama } from './ollama-api';
import { saveConfig } from './config';
import { createLogger } from './logger';
import { checkForUpdate, performUpdate } from './self-update';
import { tasks } from './task-tracker';
import { emitBootEvent } from './boot-events';
import { processGlobal } from './process-global';
import { closeLeasesForOwner, startSweeper } from './leases';
import {
  AddressStabilityTracker,
  resolveAgentUrl,
  shouldReadvertise,
  type InterfaceMap,
  type ResolvedAgentUrl,
} from './agent-address';

const log = createLogger('gossip');

// Per-master "first successful connect" flag. Emits the boot event once per
// boot per master, not on every reconnect / heartbeat cycle.
const G = processGlobal('ws-client', () => ({
  firstConnectEmitted: new Set<string>(),
  updateCheckInterval: null as ReturnType<typeof setInterval> | null,
  watchdogTimer: null as ReturnType<typeof setInterval> | null,
  currentAgentUrl: null as string | null,
  addressStability: new AddressStabilityTracker(),
}));

// Update-check is a process-wide concern, not per-master. Run it once against
// the first master only — the binary doesn't need N parallel update probes.

const PORT = parseInt(process.env.AGENT_PORT || process.env.PORT || '8098', 10);
const HEARTBEAT_INTERVAL = 5_000;  // 5s heartbeat
const POLL_INTERVAL = 3_000;       // 3s poll when WS is down
// Once the reconnect backoff has grown past this, the master is REPORTED
// unreachable: it shows as such in /api/status and stops logging an error every
// cycle. It is NOT given up on — the capped backoff keeps retrying, because a
// master that is merely rebooting must come back without operator action.
// 1s doubling reaches 64s after six consecutive failures.
const UNREACHABLE_AFTER_DELAY_MS = 60_000;
// Same idea on the HTTP-gossip path, counted in consecutive heartbeat failures
// rather than in backoff. At the 5s heartbeat this is ~1 minute.
const UNREACHABLE_AFTER_FAILURES = 12;

// ─── Agent URL detection ──────────────────────────────────────────────────

// The address we are currently advertising. Resolved once, then changed ONLY by
// revalidateAgentUrl(). getAgentUrl() is called on every heartbeat (via
// buildFullStatus), so it must not re-run detection each time: on a multi-homed
// host that would let the advertised address flap between NICs several times a
// minute, and with the master-side re-key each flip migrates registry state.

// Debounce for re-advertisement — a replacement must be seen on N consecutive
// revalidation ticks before it is adopted.

/**
 * Host of a configured master, used to break ties on a multi-homed host: the
 * interface on the master's /24 is the one that can reach it. Hint only — null
 * when no master is configured or its URL is unparseable.
 */
function firstMasterHost(): string | null {
  for (const serverUrl of state.masters.keys()) {
    try { return new URL(serverUrl).hostname; } catch { /* try the next */ }
  }
  if (state.serverUrl) {
    try { return new URL(state.serverUrl).hostname; } catch { /* fall through */ }
  }
  return null;
}

function resolveNow(): ResolvedAgentUrl {
  return resolveAgentUrl({
    env: { AGENT_URL: process.env.AGENT_URL, EXTERNAL_IP: process.env.EXTERNAL_IP },
    savedAgentUrl: state.savedAgentUrl,
    interfaces: os.networkInterfaces() as InterfaceMap,
    port: PORT,
    masterHost: firstMasterHost(),
  });
}

export function getAgentUrl(): string {
  if (G.currentAgentUrl) return G.currentAgentUrl;
  const resolved = resolveNow();
  G.currentAgentUrl = resolved.url;
  log.info(
    `Advertised address resolved: ${resolved.url} (source=${resolved.source}` +
    `${resolved.iface ? `, iface=${resolved.iface}` : ''})`,
  );
  return G.currentAgentUrl;
}

/**
 * Boot-time reconciliation. `state.savedAgentUrl` is only ever written by the
 * self-update path (self-update.ts) and is self-perpetuating, so a host that has
 * self-updated once carries the address it had at that moment forever. Detection
 * now outranks it (agent-address.ts), so the value getAgentUrl() returns at boot
 * is already correct — this just writes the correction back so the config file
 * stops carrying the stale pin, and says so in the log.
 */
export function initAgentAddress(): void {
  const pinned = state.savedAgentUrl;
  const url = getAgentUrl();
  if (pinned && pinned !== url) {
    log.warn(
      `Advertised address corrected at boot: persisted pin ${pinned} → ${url} ` +
      `(the pin was written by a past self-update and is no longer this host's address)`,
    );
  }
  if (pinned !== url) {
    state.savedAgentUrl = url;
    try { saveConfig(); } catch (err) {
      log.warn(`Failed to persist corrected agentUrl: ${(err as Error).message}`);
    }
  }
}

/**
 * One revalidation tick: if the address we advertise is no longer one of this
 * host's own addresses, re-detect and re-advertise. Re-registers on every live
 * socket so the master can re-key its registry entry rather than growing a
 * second one (src/lib/gpu/ws-relay.ts handles the same-socket move).
 *
 * Returns the new URL when it changed, else null. No-ops when AGENT_URL or
 * EXTERNAL_IP is set — a NAT'd host correctly advertises a non-local address.
 */
export function revalidateAgentUrl(): string | null {
  const current = getAgentUrl();
  const decision = shouldReadvertise({
    current,
    env: { AGENT_URL: process.env.AGENT_URL, EXTERNAL_IP: process.env.EXTERNAL_IP },
    interfaces: os.networkInterfaces() as InterfaceMap,
    port: PORT,
    masterHost: firstMasterHost(),
    tracker: G.addressStability,
  });

  if (decision.reason === 'awaiting-stability') {
    const p = G.addressStability.progress;
    log.info(
      `Advertised address ${current} is no longer local; candidate ${p.candidate} ` +
      `seen ${p.streak}/${p.samples} times — holding until stable`,
    );
    return null;
  }
  if (!decision.act) return null;

  const next = decision.next!;
  // Loud on purpose, with both values: a silent address change is its own
  // debugging problem, and this one moves what the master calls.
  log.warn(`Advertised address CHANGED: ${current} → ${next} (old address is no longer local to this host)`);
  emitBootEvent(`Advertised address changed: ${current} → ${next}`, { from: current, to: next });

  G.currentAgentUrl = next;
  state.savedAgentUrl = next;
  try { saveConfig(); } catch (err) {
    log.warn(`Failed to persist changed agentUrl: ${(err as Error).message}`);
  }
  reregisterOnLiveSockets(next);
  return next;
}

/**
 * Re-send `register` on every open socket. Deliberately reuses the existing
 * connection instead of forcing a reconnect: on the same socket the master can
 * prove the new address belongs to the sidecar it is already talking to, which
 * is what lets it move the registry key instead of creating a duplicate.
 */
function reregisterOnLiveSockets(agentUrl: string): void {
  for (const m of state.masters.values()) {
    if (m.ws?.readyState !== WebSocket.OPEN) continue;
    try {
      m.ws.send(JSON.stringify({
        type: 'register',
        agentUrl,
        hostname: getDisplayHostname(),
        containers: getRegisteredContainers(),
      }));
      log.info(`[${m.serverUrl}] Re-registered with corrected agentUrl ${agentUrl}`);
    } catch (err) {
      log.warn(`[${m.serverUrl}] Re-register after address change failed: ${(err as Error).message}`);
    }
  }
}

function getDisplayHostname(): string {
  if (process.env.SIDECAR_HOSTNAME) return process.env.SIDECAR_HOSTNAME;
  const dockerHostName = getDockerHostName();
  if (dockerHostName) return dockerHostName;
  if (process.env.COMPUTERNAME) return process.env.COMPUTERNAME;
  const hostname = os.hostname();
  if (/^[0-9a-f]{12,}$/.test(hostname)) {
    const ip = process.env.EXTERNAL_IP;
    return ip ? `gpu-${ip.split('.').pop()}` : `sidecar-${hostname.substring(0, 8)}`;
  }
  return hostname;
}

function getRegisteredContainers(): string[] {
  return Object.values(state.registry).map((d) => d.containerName);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

function httpPost(
  url: string,
  body: object,
  authToken?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
    };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Parse `X-Sound-Suite-Master-Url` from a master→sidecar response.
 *
 * This used to call `ensureMaster(normalized, {})` whenever the URL was not
 * already a key — **adding a second slot for the master whose own response
 * carried the header**. One master, two slots. The added slot had no `wsPort`, so
 * `m.wsPort ?? 3002` dialled it at the default, which is the same endpoint the
 * original slot uses whenever that master is Sound Suite. Both slots then register
 * with the same `agentUrl`; the master supersedes per `agentUrl` rather than per
 * slot, so they evict each other indefinitely. The header rides on EVERY
 * heartbeat, poll and result reply, and the master has always sent it — which is
 * why the churn appeared on every sidecar version and survived a rollback.
 *
 * The recovery this was written for does not need a new slot: we are talking to
 * the master right now, over `m.serverUrl`, and `saveConfig()` already persists
 * that key. A URL we have not dialled is unverified (task 41 — a wrong address
 * takes the host dark), so it is recorded in the log and nowhere else.
 *
 * Same rule as the `master-identity` frame: **one master is one slot.**
 */
function absorbMasterUrlHeader(
  m: MasterConnection,
  headers: http.IncomingHttpHeaders,
  sourceLabel: string,
): void {
  const raw = headers['x-sound-suite-master-url'];
  const masterUrl = Array.isArray(raw) ? raw[0] : raw;
  if (typeof masterUrl !== 'string' || masterUrl.length === 0) return;
  const normalized = masterUrl.replace(/\/+$/, '');
  if (normalized === m.serverUrl) return;
  if (m.absorbedHeaderUrl === normalized) return;   // log once per value, not per reply
  m.absorbedHeaderUrl = normalized;
  log.info(
    `[${m.serverUrl}] Master self-identified via header (${sourceLabel}) as ` +
    `${normalized} — NOT adding a second slot for it. Keeping the key this ` +
    `connection works on; set the canonical URL in /setup if it should change.`,
  );
}

// ─── Rich status builder ──────────────────────────────────────────────────

async function buildFullStatus(): Promise<Record<string, unknown>> {
  const status = await handleStatus();
  let gpus: unknown[] = [];
  try {
    gpus = await discoverGpus();
  } catch { /* gpu discovery optional */ }

  const freeVram = (gpus as any[]).reduce((sum, g) => sum + (g.memoryFree || 0), 0);
  const totalVram = (gpus as any[]).reduce((sum, g) => sum + (g.memoryTotal || 0), 0);

  const anyWs = anyWebSocketConnected();

  return {
    agentUrl: getAgentUrl(),
    hostname: getDisplayHostname(),
    version: status.agent && typeof status.agent === 'object' ? (status.agent as Record<string, unknown>).version : '2.0',
    mode: status.mode,
    uptime: status.agent && typeof status.agent === 'object' ? (status.agent as Record<string, unknown>).uptime : 0,
    containers: status.containers,
    activeRequests: status.activeRequests,
    idleTimeouts: status.idleTimeouts,
    roles: status.roles,
    peakDemand: status.peakDemand,
    gpus,
    freeVram,
    totalVram,
    wsConnected: anyWs,
    containerNames: getRegisteredContainers(),
    tasks: tasks.getAll(),
    // Critical: forward dockerMode to the master so the master's
    // RerankerLifecycle + min-online enforcer can short-circuit /acquire
    // when this sidecar can't talk to Docker (dockerMode === 'none').
    // Without this field on the heartbeat, the master never learns that
    // /acquire will be rejected and fires it on every tick → log spam.
    dockerMode: status.dockerMode,
  };
}

export function anyWebSocketConnected(): boolean {
  for (const m of state.masters.values()) {
    if (m.connectionMode === 'websocket' && m.ws?.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

// ─── Command execution ────────────────────────────────────────────────────

async function executeCommand(
  m: MasterConnection,
  cmd: { id: string; action: string; payload?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const action = cmd.action.replace(/^\//, '');
  const payload = cmd.payload || {};
  const role = payload.role as string | undefined;

  log.info(`[${m.serverUrl}] Executing command: ${action} (id: ${cmd.id})`);

  switch (action) {
    // The master's serverUrl owns any lease this command opens, so a dropped
    // socket can release exactly what that master still owed (see the close
    // handler's closeLeasesForOwner call).
    case 'acquire': return handleAcquire(role, m.serverUrl);
    case 'release': return handleRelease(role, typeof payload.leaseId === 'string' ? payload.leaseId : undefined);
    case 'reset-counters': return handleResetCounters(role);
    case 'start': {
      if (role) {
        // Honor operator opt-out — symmetric with acquire/pullModel/loadModel.
        // A master that sends `start` for an opted-out role is bypassing the
        // policy; reject so the smoking-gun "background start loaded the
        // model" path can't fire.
        if ((state.minOnline?.[role] ?? 1) === 0) {
          log.info(`start ${role} REJECTED — minOnline=0 (operator opted this role out)`);
          return { error: `Role "${role}" is disabled (minOnline=0). Set Minimum Online > 0 in admin to allow start.` };
        }
        const check = await checkVram(role);
        if (!check.ok) return { error: check.reason };
      }
      return handleStart(role);
    }
    case 'stop': return handleStop(role);
    case 'status': return handleStatus();
    case 'gpu': return { gpus: await discoverGpus() };
    case 'containers': return { containers: await getAllContainerStates() };
    case 'health': return { ok: true, uptime: Math.floor((Date.now() - state.startedAt) / 1000) };
    case 'mode': return switchMode(payload.mode as string);
    case 'provision': return provisionContainers();
    case 'update': {
      const { available, version } = await checkForUpdate(m.serverUrl);
      if (!available) return { ok: true, message: 'Already up to date' };
      const updated = await performUpdate(m.serverUrl);
      return updated ? { ok: true, message: `Updating to v${version}` } : { error: 'Update failed' };
    }
    case 'config': {
      // config-push targets ONLY this master's slot — never adds a 2nd master.
      // If payload.serverUrl != current key, we re-key this slot in place.
      // SHARED FIELDS (idleTimeouts, minOnline, registry) still mutate global
      // state — needs namespacing later (v1 limitation).
      if (typeof payload.serverUrl === 'string' && payload.serverUrl) {
        if (m.serverUrl !== payload.serverUrl && m.connectionMode !== 'disconnected') {
          // Do NOT adopt a pushed URL for a slot whose socket is up. The master
          // resolves its canonical URL from SOUND_SUITE_MASTER_URL, then a config
          // key, then the Host header of whatever most recently hit it
          // (src/lib/gpu/master-identity.ts) — so the pushed value is not a
          // verified route, and the master re-pushes it on EVERY register
          // (ws-relay.ts:509-521). Trading the address this socket is live on for
          // an unverified one takes the host dark, and recovery means editing
          // config inside a container on a host that is by then unreachable
          // (see the startGossipClient comment and task 41). The rekey below
          // still runs when the slot is not connected — that is the recovery
          // case it was written for.
          // Gate on connectionMode, not on `m.ws`: a slot in HTTP-gossip
          // fallback has `m.ws === null` and is still connected and working on
          // its current key — and `pollForCommands` routes `config` through the
          // same handler, so gating on the socket alone would let the rekey move
          // exactly the host that is already degraded and least able to recover.
          log.info(
            `[${m.serverUrl}] Master pushed serverUrl ${payload.serverUrl}; keeping ` +
            `the key this ${m.connectionMode} connection is working on (rekey only ` +
            `applies to a slot that is disconnected)`,
          );
        } else if (m.serverUrl !== payload.serverUrl) {
          log.info(`[${m.serverUrl}] Master pushed serverUrl rename → ${payload.serverUrl}`);
          const res = rekeyMaster(m.serverUrl, payload.serverUrl);
          if (!res.ok && res.reason === 'conflict') {
            // A rename onto a slot another master already holds used to be a
            // silent `set()`: the occupant fell out of the map with its socket
            // and timers still running, and `masters` shrank by one with
            // nothing above INFO to say so. The sidecar cannot know which slot
            // the operator meant, so refuse and say both URLs out loud. The
            // operator resolves it from /setup, which answers 409 for the same
            // collision (api/masters/[serverUrl] PATCH).
            log.warn(
              `[${m.serverUrl}] REFUSED serverUrl rename → ${payload.serverUrl}: ` +
              `that URL is already held by a different master slot. Both slots ` +
              `kept as-is; no master was dropped. Resolve it by removing one ` +
              `entry in /setup.`,
            );
          } else if (!res.ok) {
            log.warn(`[${m.serverUrl}] serverUrl rename → ${payload.serverUrl} failed: ${res.reason}`);
          }
        }
      }
      if (payload.idleTimeouts) Object.assign(state.idleTimeouts, payload.idleTimeouts);
      const rolesNowOptOut: string[] = [];
      if (payload.minOnline && typeof payload.minOnline === 'object') {
        for (const [k, v] of Object.entries(payload.minOnline as Record<string, unknown>)) {
          if (typeof v === 'number' && v >= 0) {
            const prev = state.minOnline[k];
            state.minOnline[k] = v;
            if (v === 0 && prev !== 0) rolesNowOptOut.push(k);
          }
        }
      }
      if (payload.containerName) state.CONTAINER_NAME = payload.containerName as string;
      state.lastConfigPushAt = Date.now();

      // ─── Master-pushed hostOs override ────────────────────────────────
      // Pinned by the operator via /admin/host-provisioning. Highest
      // precedence — overrides env hint and auto-detect. Applied BEFORE
      // the registry-rebuild logic so resolveMode() below sees the new
      // hostOs. Idempotent: same value pushed twice = no-op. Persists via
      // saveConfig() at the end of this handler so it survives reboot.
      const pushedOs = payload.hostOsOverride;
      if (pushedOs === 'mac-docker-ollama' || pushedOs === 'windows-docker-wsl2' || pushedOs === 'linux') {
        if (state.hostOs !== pushedOs || state.hostOsConfidence !== 'master-override') {
          log.info(`[${m.serverUrl}] Master pushed hostOsOverride: ${state.hostOs} (${state.hostOsConfidence}) -> ${pushedOs} (master-override)`);
          state.hostOs = pushedOs;
          state.hostOsConfidence = 'master-override';
        }
      } else if (pushedOs === null && state.hostOsConfidence === 'master-override') {
        // Operator picked "Auto" on the UI — clear the pin and re-detect.
        // detectHostOs() walks env → Docker /info; resets confidence to
        // whatever it finds. saveConfig() at end of handler drops the
        // null hostOsOverride from disk.
        log.info(`[${m.serverUrl}] Master cleared hostOsOverride — re-running detection`);
        try {
          const { detectHostOs } = await import('./host-os');
          await detectHostOs();
        } catch (err) {
          log.warn(`detectHostOs after master clear failed: ${(err as Error).message}`);
        }
      }
      if (rolesNowOptOut.length > 0) {
        const { stopContainer } = await import('./docker');
        const { ollamaUnload } = await import('./ollama-api');
        for (const role of rolesNowOptOut) {
          const def = state.registry[role];
          if (!def) continue;
          const active = state.perRole[role]?.activeRequests ?? 0;
          if (active > 0) continue;
          // Mark user-stopped so the heartbeat auto-loader doesn't reload
          // within the next cycle.
          ensureSet('userStopped').add(role);
          try {
            if (def.runtime === 'host') {
              // Host-runtime: model lives in native Ollama's VRAM with
              // keep_alive: 24h. The Docker stopContainer path doesn't
              // touch it — we must call /api/generate with keep_alive=0
              // to actually evict. THIS is the smoking-gun fix for
              // qwen3.5:9b staying loaded after opt-out.
              if (def.model) {
                const ok = await ollamaUnload(def.port, def.model, role);
                if (ok) log.info(`Auto-unloaded ${def.model} (${role}) on host Ollama — minOnline transitioned to 0`);
                else log.warn(`Failed to auto-unload ${def.model} (${role}) on host Ollama (best-effort)`);
              }
            } else if (def.runtime === 'docker-model-runner') {
              // DMR has no unload API; its scheduler reaps idle workers.
              log.info(`minOnline→0 for ${role} on DMR — no unload API; DMR will reap on idle`);
            } else {
              const cs = await getContainerState(def.containerName);
              if (cs.status === 'running') {
                await stopContainer(def.containerName);
                log.info(`Auto-stopped ${def.containerName} — minOnline transitioned to 0`);
              }
            }
          } catch (err) {
            log.warn(`Auto-evict on opt-out failed for ${role}: ${(err as Error).message}`);
          }
        }
      }
      const modelChangedRoles: string[] = [];

      // ─── NEW SHAPE: enabledModes + modelOverrides ────────────────────
      // Master sends a list of mode names (`ss-embedding`, etc) and the
      // sidecar resolves each to a ContainerDef via its own hostOs. This
      // is the canonical post-2.3 contract. Falls through to the legacy
      // `payload.registry` branch when neither field is present, so older
      // masters keep working during rollout.
      //
      // DEFENSIVE: empty enabledModes array is treated as "no opinion —
      // keep defaults" rather than "remove everything". This protects
      // against a master pushing an empty list during initial sync (e.g.
      // because no operator assignments exist yet, or the master's
      // simplify_role_catalog migration hasn't been applied). The sidecar
      // only trims roles when the operator has explicitly assigned a
      // non-empty mode set. Fail closed, not open.
      if (Array.isArray(payload.enabledModes) && (payload.enabledModes as unknown[]).length > 0) {
        const { resolveMode, modeToRole, isModeName, ALL_MODES, withGpuMemUtil, withBoolFlag } =
          await import('./mode-templates');
        const enabled = (payload.enabledModes as unknown[]).filter(
          (m): m is string => typeof m === 'string',
        );
        const overrides =
          (payload.modelOverrides && typeof payload.modelOverrides === 'object'
            ? (payload.modelOverrides as Record<string, unknown>)
            : {}) as Record<string, unknown>;
        const runtimes =
          (payload.runtimes && typeof payload.runtimes === 'object'
            ? (payload.runtimes as Record<string, unknown>)
            : {}) as Record<string, unknown>;
        // Per-role vLLM --gpu-memory-utilization (keyed by short role name),
        // operator-tuned on /admin/* and stored as gpu.memUtil.*. Applied onto
        // the freshly resolved ContainerDef below so it survives the wholesale
        // registry replace.
        const gpuMemUtils =
          (payload.gpuMemUtils && typeof payload.gpuMemUtils === 'object'
            ? (payload.gpuMemUtils as Record<string, unknown>)
            : {}) as Record<string, unknown>;
        // Reranker-only: toggle --enforce-eager in its vllmArgs (off = CUDA
        // graphs + torch.compile for throughput). Undefined → leave default.
        const rerankEnforceEager =
          typeof payload.rerankEnforceEager === 'boolean' ? payload.rerankEnforceEager : undefined;

        // Build the per-host effective set of role keys (short names).
        const enabledRoles = new Set<string>();
        // Track how many modes were valid mode names (separate from how many
        // resolved successfully). A non-empty list of valid names whose
        // resolutions ALL returned null is a CLEAR signal: "master asked for
        // things this OS can't do." That's a legit trim-everything intent —
        // NOT a malformed payload to defensively ignore.
        let validNameCount = 0;
        for (const mode of enabled) {
          if (!isModeName(mode)) {
            log.warn(`[${m.serverUrl}] Unknown mode "${mode}" — skipping`);
            continue;
          }
          validNameCount++;
          const rtRaw = runtimes[mode];
          const runtime =
            rtRaw === 'host' || rtRaw === 'docker-ollama' ||
            rtRaw === 'docker-vllm' || rtRaw === 'docker-model-runner'
              ? rtRaw
              : undefined;
          const def = resolveMode(mode, state.hostOs, runtime);
          if (!def) {
            log.warn(
              `[${m.serverUrl}] Mode "${mode}" runtime "${runtime ?? 'auto'}" not satisfiable on ${state.hostOs} — skipping`,
            );
            continue;
          }
          const role = modeToRole(mode);
          // Apply per-mode modelOverride (looked up by mode name).
          const overrideVal = overrides[mode];
          if (typeof overrideVal === 'string' && overrideVal.length > 0) {
            def.model = overrideVal;
          }
          // Apply per-role gpu-memory-utilization (vLLM roles only).
          const memUtilVal = gpuMemUtils[role];
          if (def.type === 'vllm' && typeof memUtilVal === 'number') {
            def.vllmArgs = withGpuMemUtil(def.vllmArgs, memUtilVal);
          }
          // Apply reranker enforce-eager toggle.
          if (role === 'reranker' && rerankEnforceEager !== undefined) {
            def.vllmArgs = withBoolFlag(def.vllmArgs, '--enforce-eager', rerankEnforceEager);
          }

          const existing = state.registry[role];
          if (existing) {
            const oldModel = existing.model;
            // Replace wholesale — the sidecar is now the authority on
            // image/port/vram/type per OS. Operator only owns model.
            state.registry[role] = def;
            state.pullFailCount[role] = 0;
            if (def.model && def.model !== oldModel) modelChangedRoles.push(role);
          } else {
            state.registry[role] = def;
            state.perRole[role] = { activeRequests: 0, idleTimer: null, lastAcquire: null, lastRelease: null };
            state.peakDemand[role] = { samples: [], peak: 0, windowMs: 5 * 60 * 1000 };
            if (def.model) modelChangedRoles.push(role);
            log.info(`Resolved mode ${mode} → role ${role} (image=${def.image || 'host'}, model=${def.model ?? 'n/a'})`);
          }
          enabledRoles.add(role);
        }

        // TRIM: drop any non-utility role no longer in enabledRoles.
        //
        // Two cases to trim:
        //   1. enabledRoles non-empty (master asked for specific roles and
        //      at least one resolved on this OS).
        //   2. validNameCount > 0 BUT enabledRoles is empty (master asked
        //      for valid mode names that are all unavailable on this OS,
        //      e.g. ss-reranker on mac-docker-ollama). That's an intentional
        //      "this host should run nothing besides utility" signal —
        //      previously skipping the trim left the boot-default 5-role
        //      registry intact, so the master and the sidecar disagreed
        //      forever about what's running.
        //
        // We still skip when the operator sent ZERO valid names (which
        // suggests a malformed payload).
        // Defensive: when hostOs hasn't been classified AND we have no GPU
        // evidence yet (mode-templates' linux fall-through hasn't kicked in),
        // a "trim everything" decision is suspicious — it means resolveMode
        // returned null for every requested mode purely because hostOs was
        // unknown. Skip the trim and leave the registry intact; the next
        // config push (or a successful GPU discovery) will reconcile.
        const hostOsAmbiguous =
          state.hostOs === 'unknown' &&
          !(Array.isArray(state.gpuCache) && state.gpuCache.length > 0);
        const allUnresolvedDueToHostOs =
          validNameCount > 0 && enabledRoles.size === 0 && hostOsAmbiguous;
        const shouldTrim =
          !allUnresolvedDueToHostOs &&
          (enabledRoles.size > 0 || validNameCount > 0);
        if (allUnresolvedDueToHostOs) {
          log.warn(
            `[${m.serverUrl}] hostOs="unknown" and no GPU evidence yet — ` +
            `skipping trim of ${validNameCount} requested mode(s). ` +
            `Set HOST_OS=linux|mac-docker-ollama|windows-docker-wsl2 env (or POST /api/host-os) to pin.`,
          );
        }
        if (shouldTrim) {
          for (const r of Object.keys(state.registry)) {
            if (state.registry[r].type === 'utility') continue;
            if (!enabledRoles.has(r)) {
              log.info(`Mode no longer enabled for role "${r}" — removing from registry`);
              delete state.registry[r];
              delete state.perRole[r];
              delete state.peakDemand[r];
              delete state.pullFailCount[r];
              delete state.lastModelAttempt[r];
              ensureSet('modelLoading').delete(r);
              ensureSet('userStopped').delete(r);
            }
          }
          if (enabledRoles.size === 0) {
            log.warn(
              `[${m.serverUrl}] All ${validNameCount} requested mode(s) unavailable on ${state.hostOs} — trimmed registry to utility roles only.`,
            );
          }
        } else {
          log.warn(
            `[${m.serverUrl}] enabledModes had no valid mode names — skipping trim (defensive against malformed payloads)`,
          );
        }

        // Acknowledge ALL_MODES for symmetry (silences unused-var lints).
        void ALL_MODES;

        // Do NOT call applyHostOllamaOverrides() here — resolveMode() already
        // encodes the host/docker choice based on hostOs. The legacy env-driven
        // override would revert runtime='host' to 'docker' when SS_HOST_OLLAMA
        // is unset, breaking mac-docker-ollama (which needs runtime='host' and has
        // image=''). The mode catalog is the authoritative source for runtime.
        //
        // We still call applySetupOverrides for /setup-persisted operator
        // choices (model name overrides, mainly).
        try {
          const { applySetupOverrides } = await import('./setup-overrides');
          applySetupOverrides();
        } catch { /* not present in older sidecars; safe to skip */ }
      } else if (payload.registry && typeof payload.registry === 'object') {
        const incoming = payload.registry as Record<string, Partial<import('./state').ContainerDef>>;
        // ADD or UPDATE: existing roles get a shallow merge; new role names
        // are accepted as long as the master sent enough fields to define
        // them. Missing fields fall back to safe defaults so an older master
        // that only sends `{ model: "..." }` still works for built-in roles.
        for (const [r, overrides] of Object.entries(incoming)) {
          if (state.registry[r]) {
            const oldModel = state.registry[r].model;
            Object.assign(state.registry[r], overrides);
            state.pullFailCount[r] = 0;
            if (state.registry[r].model && state.registry[r].model !== oldModel) {
              modelChangedRoles.push(r);
            }
          } else {
            // New role definition. Require at least image+port+type to build
            // something coherent; otherwise skip and log.
            const ov = overrides as Record<string, unknown>;
            if (typeof ov.image === 'string' && typeof ov.port === 'number' && typeof ov.type === 'string') {
              const def: import('./state').ContainerDef = {
                image: ov.image,
                model: typeof ov.model === 'string' ? ov.model : null,
                port: ov.port,
                vram: typeof ov.vram === 'number' ? ov.vram : 0,
                type: ov.type as 'ollama' | 'vllm' | 'utility',
                modes: Array.isArray(ov.modes) ? (ov.modes as ('indexing' | 'searching')[]) : ['indexing', 'searching'],
                containerName: typeof ov.containerName === 'string' ? ov.containerName : `ss-${r}`,
                gpuOnly: typeof ov.gpuOnly === 'boolean' ? ov.gpuOnly : false,
                priority: (typeof ov.priority === 'string' ? ov.priority : 'normal') as 'critical' | 'high' | 'normal',
              };
              state.registry[r] = def;
              state.perRole[r] = { activeRequests: 0, idleTimer: null, lastAcquire: null, lastRelease: null };
              state.peakDemand[r] = { samples: [], peak: 0, windowMs: 5 * 60 * 1000 };
              if (def.model) modelChangedRoles.push(r);
              log.info(`Master added new role definition: ${r} (image=${def.image}, model=${def.model ?? 'n/a'})`);
            } else {
              log.warn(`Master sent unknown role "${r}" without full definition (need image+port+type); ignored`);
            }
          }
        }
        // REMOVE: any non-utility role the master did NOT include is now
        // unassigned for this host. Drop it from the registry so the UI no
        // longer renders a "not_found" row and the auto-loader stops trying
        // to provision it. Utility roles (cuda) are managed locally by the
        // sidecar and never appear in master-driven assignments.
        for (const r of Object.keys(state.registry)) {
          if (state.registry[r].type === 'utility') continue;
          if (!(r in incoming)) {
            log.info(`Master no longer assigns role "${r}" to this host — removing from registry`);
            delete state.registry[r];
            delete state.perRole[r];
            delete state.peakDemand[r];
            delete state.pullFailCount[r];
            delete state.lastModelAttempt[r];
            state.modelLoading.delete(r);
            state.userStopped.delete(r);
          }
        }
        // CRITICAL: the master's config push contains per-role definitions
        // (model, port, image, type) that obliterate our host-runtime + DMR
        // port normalization. Re-apply overrides so SS_HOST_OLLAMA_ROLES /
        // SS_DMR_ROLES stay honored after every push. Without this, the
        // sidecar starts probing host.docker.internal:11435 (completion's
        // original docker port — nothing listens there) and floods the log
        // with ECONNREFUSED while host-Ollama itself is on :11434.
        const { applyHostOllamaOverrides } = await import('./state');
        applyHostOllamaOverrides();
        // Also re-apply setup-UI overrides so /setup persisted choices
        // take precedence over what the master pushed.
        try {
          const { applySetupOverrides } = await import('./setup-overrides');
          applySetupOverrides();
        } catch { /* not present in older sidecars; safe to skip */ }
      }
      // Kick the host-runtime watchdog if a master push (or setup override)
      // enabled host-Ollama / DMR mode AFTER boot. Without this, a sidecar
      // that booted with hostOllama disabled (no env) and was flipped on
      // by a master config push never starts probing — state.hostOllamaLastHealth
      // stays {at:0, ok:false} forever, the master never sees the role as
      // "really running", and /acquire fires every tick. Idempotent —
      // startHostOllamaWatchdog() early-returns if the timer is already set.
      // Lives OUTSIDE the if/else above so it fires in both the modern
      // (enabledModes) and legacy (payload.registry) config-push paths.
      // Always invoke startHostOllamaWatchdog — its own gate now also fires
      // on registry-resident runtime='host' roles, catching the
      // mac-docker-ollama path where SS_HOST_OLLAMA env wasn't set in the
      // container but mode-templates resolved roles to runtime='host'.
      try {
        const { startHostOllamaWatchdog } = await import('./host-ollama-watchdog');
        startHostOllamaWatchdog();
      } catch (err) {
        log.warn(`[${m.serverUrl}] startHostOllamaWatchdog after config push failed: ${(err as Error).message}`);
      }
      saveConfig();
      // Orphan sweep: stop any ss-* docker container whose name doesn't
      // appear in the post-push registry. When the operator unchecks a role
      // in /admin/roleassign, the live container would otherwise keep
      // running and holding VRAM because the sidecar no longer iterates it.
      // We STOP (not REMOVE) so re-enabling the role is a fast `docker
      // start` — image + config preserved. Fire-and-forget; errors are
      // logged but don't fail the push.
      try {
        const { stopOrphanContainers } = await import('./containers');
        void stopOrphanContainers().catch((err) => {
          log.warn(`[${m.serverUrl}] orphan sweep failed: ${(err as Error).message}`);
        });
      } catch (err) {
        log.warn(`[${m.serverUrl}] orphan sweep import failed: ${(err as Error).message}`);
      }
      if (modelChangedRoles.length > 0) {
        log.info(`Config push changed models for: ${modelChangedRoles.join(', ')} — triggering ensureOllamaModel`);
        for (const r of modelChangedRoles) {
          handleAcquire(r).catch(err => log.warn(`Auto-acquire after config push failed for ${r}: ${(err as Error).message}`));
        }
      }
      return { ok: true, idleTimeouts: state.idleTimeouts, containerName: state.CONTAINER_NAME };
    }
    case 'pullModel': {
      // Master's "Pull" / "Pull & Load" button. Runtime-aware dispatch lives
      // in handlePullModel — host-Ollama, docker-ollama, docker-vllm, and
      // docker-model-runner all routed there. Default behavior remains
      // pull-and-load (matches the historical wire contract); to pull only,
      // pass payload.andLoad=false.
      const pullRole = payload.role as string;
      const andLoad = payload.andLoad === false ? false : true;
      return handlePullModel(pullRole, andLoad);
    }
    case 'pullAndLoad': {
      // Explicit form used by the sidecar GUI; kept distinct for clarity even
      // though pullModel above defaults to andLoad=true.
      const pullRole = payload.role as string;
      return handlePullModel(pullRole, true);
    }
    case 'loadModel': {
      // Master's "Load" button. handleLoadModel branches on runtime/type:
      //   host           → ollamaLoad on hostOllamaHost
      //   docker-ollama  → ensureContainer + ollamaLoad
      //   docker-vllm    → start container (vLLM loads at startup)
      //   docker-model-runner → no-op (DMR lazy-loads)
      const loadRole = payload.role as string;
      return handleLoadModel(loadRole);
    }
    default:
      return { error: `Unknown action: ${action}` };
  }
}

// ─── VRAM check ───────────────────────────────────────────────────────────

async function checkVram(role: string): Promise<{ ok: boolean; reason?: string }> {
  const def = state.registry[role];
  if (!def) return { ok: false, reason: `Unknown role: ${role}` };

  try {
    const gpus = await discoverGpus();
    if (gpus.length === 0) return { ok: true };

    const gpu = gpus[0];
    if (gpu.memoryFree < def.vram) {
      return {
        ok: false,
        reason: `Need ${def.vram}MB VRAM for ${role} but only ${gpu.memoryFree}MB free on ${gpu.name}`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

// ─── Auto-provision on startup ────────────────────────────────────────────

async function autoProvision(): Promise<void> {
  const allRoles = Object.keys(state.registry);
  const activeRoles = containersForMode(state.currentMode);

  // Mac/Windows Docker has no GPU passthrough. Any nvidia/cuda or vllm
  // container will fail with "no known GPU vendor", and CPU-only Ollama
  // is unusably slow. Refuse to auto-provision Docker containers here —
  // operator should set SS_HOST_OLLAMA=1 to use native Ollama instead.
  if (!dockerSupportsGpu()) {
    const hostRoles = allRoles.filter(r => state.registry[r]?.runtime === 'host');
    log.warn(
      `Auto-provisioning skipped: Docker on ${state.hostOs} has no GPU support. ` +
      `${hostRoles.length > 0
        ? `Host-Ollama mode is on for: ${hostRoles.join(', ')} (managed via native Ollama, not Docker).`
        : 'Set SS_HOST_OLLAMA=1 with SS_HOST_OLLAMA_ROLES=embedding,completion,ocr to enable native Ollama. ' +
          'Or move this sidecar to a Linux+NVIDIA host for Docker-managed roles.'
      }`,
    );
    // Still run the post-provision activation loop below — it handles host-
    // runtime roles (model pull + warm-up on native Ollama) without Docker.
    if (hostRoles.length === 0) return;
  }

  log.info(`Auto-provisioning ALL roles: ${allRoles.join(', ')} (active for "${state.currentMode}": ${activeRoles.join(', ')})`);

  let availableVram = Infinity;
  try {
    const gpus = await discoverGpus();
    if (gpus.length > 0) {
      availableVram = gpus[0].memoryFree;
      log.info(`Available VRAM: ${availableVram}MB on ${gpus[0].name}`);
    }
  } catch {
    log.warn('Could not discover GPU — will provision without VRAM checks');
  }

  const pulledImages = new Set<string>();
  let vramUsed = 0;

  for (const role of allRoles) {
    const def = state.registry[role];
    if (!def) continue;

    // Honor operator's minOnline=0 opt-out. autoProvision runs on boot and
    // after every WS config push, so without this guard a role with
    // minOnline=0 still gets its image pulled, container created, and
    // sometimes auto-started — defeating the operator's policy.
    if ((state.minOnline?.[role] ?? 1) === 0) {
      log.info(`autoProvision: skipping ${role} — minOnline=0 (operator opted this role out)`);
      continue;
    }

    // On a Mac/Windows sidecar, skip every Docker-runtime role — only
    // host-runtime roles get further processing (model pull on native Ollama).
    if (!dockerSupportsGpu() && def.runtime !== 'host') continue;

    try {
      const cs = await getContainerState(def.containerName);
      if (cs.exists) {
        log.info(`${role}: container ${def.containerName} exists (${cs.status})`);
        if (cs.status === 'running') vramUsed += def.vram;
        continue;
      }

      if (!pulledImages.has(def.image)) {
        try {
          const { status: imgStatus } = await dockerRequest('GET', `/images/${encodeURIComponent(def.image)}/json`);
          if (imgStatus === 200) {
            log.info(`${role}: image ${def.image} already exists locally`);
            pulledImages.add(def.image);
          } else {
            const imgTaskId = tasks.start('image-pull', `Pull ${def.image}`, role);
            log.info(`${role}: pulling image ${def.image}...`);
            try {
              await pullImage(def.image, {
                onProgress: (progress, detail) => tasks.update(imgTaskId, { progress, detail }),
              });
              tasks.complete(imgTaskId);
            } catch (err) {
              tasks.fail(imgTaskId, (err as Error).message);
              throw err;
            }
            pulledImages.add(def.image);
          }
        } catch (err) {
          log.error(`${role}: failed to pull ${def.image}: ${(err as Error).message}`);
          continue;
        }
      } else {
        log.info(`${role}: image ${def.image} already pulled`);
      }

      log.info(`${role}: creating container ${def.containerName}...`);
      await createContainer(role);
      log.info(`${role}: container created`);
    } catch (err) {
      log.error(`${role}: provision failed: ${(err as Error).message}`);
    }
  }

  const sortedActive = [...activeRoles].sort((a, b) => {
    const va = state.registry[a]?.vram || 0;
    const vb = state.registry[b]?.vram || 0;
    return va - vb;
  });

  for (const role of sortedActive) {
    const def = state.registry[role];
    if (!def) continue;

    try {
      const cs = await getContainerState(def.containerName);
      if (!cs.exists) continue;

      const alreadyRunning = cs.status === 'running';
      if (alreadyRunning) vramUsed += def.vram;

      if (!alreadyRunning && vramUsed + def.vram > availableVram) {
        log.warn(`${role}: skipping start — needs ${def.vram}MB but only ${availableVram - vramUsed}MB free`);
        continue;
      }

      if (def.type === 'ollama' && def.model) {
        try {
          if (!alreadyRunning) {
            log.info(`${role}: starting container to pull model ${def.model}...`);
            await startContainer(def.containerName);
            vramUsed += def.vram;
          }
          await waitForOllama(def.port);

          const diskModels = await ollamaList(def.port);
          const modelBase = def.model.split(':')[0];
          if (!diskModels.some(m => m.includes(modelBase))) {
            const pullTaskId = tasks.start('model-pull', `Pull ${def.model}`, role);
            log.info(`${role}: pulling model ${def.model} via HTTP API (this may take a while)...`);
            try {
              await ollamaPull(def.port, def.model, {
                onProgress: (pct, detail) => {
                  tasks.update(pullTaskId, { progress: pct, detail: detail.slice(0, 80) });
                },
              });
              const verifyModels = await ollamaList(def.port);
              if (!verifyModels.some(m => m.includes(modelBase))) {
                tasks.fail(pullTaskId, 'Model not found on disk after pull');
                throw new Error(`${def.model} not found on disk after pull`);
              }
              tasks.complete(pullTaskId);
              log.info(`${role}: model ${def.model} pulled`);
            } catch (err) {
              if (tasks.getActive().some(t => t.id === pullTaskId)) {
                tasks.fail(pullTaskId, (err as Error).message);
              }
              throw err;
            }
          } else {
            log.info(`${role}: model ${def.model} already on disk`);
          }

          if (!ensureSet('modelLoading').has(role)) {
            ensureSet('modelLoading').add(role);
            const loadTaskId = tasks.start('model-load', `Load ${def.model} into VRAM`, role);
            ollamaLoad(def.port, def.model, {
              onProgress: (detail) => {
                if (detail) tasks.update(loadTaskId, { detail: detail.slice(0, 100) });
              },
            }).then((ok) => {
              if (ok) tasks.complete(loadTaskId);
              else tasks.fail(loadTaskId, 'Load returned false');
            }).catch((err) => {
              tasks.fail(loadTaskId, (err as Error).message);
            }).finally(() => {
              ensureSet('modelLoading').delete(role);
            });
          }
        } catch (pullErr) {
          log.error(`${role}: model pull/load failed: ${(pullErr as Error).message}`);
        }
      } else if (!alreadyRunning) {
        log.info(`${role}: starting container...`);
        await startContainer(def.containerName);
        vramUsed += def.vram;
        log.info(`${role}: started`);
      }
    } catch (err) {
      log.error(`${role}: start failed: ${(err as Error).message}`);
    }
  }

  log.info(`Auto-provision complete. VRAM allocated: ~${vramUsed}MB / ${availableVram === Infinity ? '??' : availableVram}MB`);
}

// ─── Per-master HTTP heartbeat + command poll ────────────────────────────

async function sendHttpHeartbeat(m: MasterConnection): Promise<void> {
  try {
    const fullStatus = await buildFullStatus();
    const { status, body: responseBody, headers: respHeaders } = await httpPost(
      `${m.serverUrl}/api/admin/gpu/sidecars/heartbeat`,
      fullStatus,
      m.authToken,
    );

    absorbMasterUrlHeader(m, respHeaders, 'heartbeat');

    if (status === 200) {
      if (m.httpHeartbeatFailCount > 0) {
        log.info(`[${m.serverUrl}] HTTP heartbeat recovered after ${m.httpHeartbeatFailCount} failures`);
      }
      m.httpHeartbeatFailCount = 0;
      m.unreachable = false;
      m.lastHeartbeatAt = Date.now();
      try {
        const response = JSON.parse(responseBody);
        if (response.commands && Array.isArray(response.commands)) {
          for (const cmd of response.commands) {
            processCommand(m, cmd);
          }
        }
      } catch { /* parse error, ignore */ }
    } else {
      m.httpHeartbeatFailCount++;
      log.warn(`[${m.serverUrl}] HTTP heartbeat returned ${status} (${m.httpHeartbeatFailCount}x)`);
    }
  } catch (err) {
    m.httpHeartbeatFailCount++;
    // `HTTP heartbeat failed (53x)` at ERROR, once per cycle, forever, is how a
    // master nobody wants any more reads in the log: as noise rather than as a
    // dead entry. Report it once at WARN, then keep retrying quietly. Still
    // retrying — unreachable is not gone.
    if (m.httpHeartbeatFailCount === UNREACHABLE_AFTER_FAILURES) {
      m.unreachable = true;
      log.warn(
        `[${m.serverUrl}] Master reported UNREACHABLE after ` +
        `${m.httpHeartbeatFailCount} consecutive heartbeat failures ` +
        `(${(err as Error).message}). Shown as unreachable in /api/status; ` +
        `still retrying, and further failures log at debug.`,
      );
    } else if (m.unreachable) {
      log.debug(`[${m.serverUrl}] HTTP heartbeat failed (${m.httpHeartbeatFailCount}x): ${(err as Error).message}`);
    } else {
      log.error(`[${m.serverUrl}] HTTP heartbeat failed (${m.httpHeartbeatFailCount}x): ${(err as Error).message}`);
    }
  }
}

async function pollForCommands(m: MasterConnection): Promise<void> {
  if (m.connectionMode === 'websocket') return;

  try {
    const { status, body: responseBody, headers: respHeaders } = await httpPost(
      `${m.serverUrl}/api/admin/gpu/sidecars/poll`,
      { agentUrl: getAgentUrl() },
      m.authToken,
    );

    absorbMasterUrlHeader(m, respHeaders, 'poll');

    if (status === 200) {
      const response = JSON.parse(responseBody);
      if (response.commands && Array.isArray(response.commands)) {
        for (const cmd of response.commands) {
          processCommand(m, cmd);
        }
      }
    }
  } catch {
    /* silent — poll failures expected when server is down */
  }
}

function processCommand(
  m: MasterConnection,
  cmd: { id: string; action: string; payload?: Record<string, unknown> },
): void {
  m.pendingCommands.set(cmd.id, { id: cmd.id, action: cmd.action, startedAt: Date.now() });
  executeCommand(m, cmd).then(async (result) => {
    log.info(`[${m.serverUrl}] Command ${cmd.id} (${cmd.action}) completed`);
    m.pendingCommands.delete(cmd.id);
    await reportResult(m, cmd.id, result);
  }).catch(async (err) => {
    log.error(`[${m.serverUrl}] Command ${cmd.id} (${cmd.action}) failed: ${(err as Error).message}`);
    m.pendingCommands.delete(cmd.id);
    await reportResult(m, cmd.id, undefined, (err as Error).message);
  });
}

async function reportResult(
  m: MasterConnection,
  commandId: string,
  result?: unknown,
  error?: string,
): Promise<void> {
  // WS-mode commands send their result inline through the WS frame already;
  // only HTTP-poll commands need this out-of-band POST.
  if (m.connectionMode !== 'websocket') {
    try {
      const { headers: respHeaders } = await httpPost(
        `${m.serverUrl}/api/admin/gpu/sidecars/result`,
        { commandId, result: result || {}, error },
        m.authToken,
      );
      absorbMasterUrlHeader(m, respHeaders, 'result');
    } catch (err) {
      log.error(`[${m.serverUrl}] Failed to report result for ${commandId}: ${(err as Error).message}`);
    }
  }
}

function startHttpHeartbeat(m: MasterConnection): void {
  stopHttpHeartbeat(m);
  m.heartbeatTimer = setInterval(() => sendHttpHeartbeat(m), HEARTBEAT_INTERVAL);
  m.pollTimer = setInterval(() => pollForCommands(m), POLL_INTERVAL);
}

function stopHttpHeartbeat(m: MasterConnection): void {
  if (m.heartbeatTimer) { clearInterval(m.heartbeatTimer); m.heartbeatTimer = null; }
  if (m.pollTimer) { clearInterval(m.pollTimer); m.pollTimer = null; }
}

// ─── Update checks (process-wide, runs against first master) ─────────────

function startUpdateChecks(): void {
  if (G.updateCheckInterval) return;
  G.updateCheckInterval = setInterval(async () => {
    const first = state.masters.values().next().value as MasterConnection | undefined;
    if (!first) return;
    const { available, version } = await checkForUpdate(first.serverUrl);
    if (available) {
      log.info(`Auto-updating to v${version}...`);
      await performUpdate(first.serverUrl);
    }
  }, 5 * 60 * 1000);

  (async () => {
    const first = state.masters.values().next().value as MasterConnection | undefined;
    if (!first) return;
    const { available, version } = await checkForUpdate(first.serverUrl);
    if (available) {
      log.info(`Update available (v${version}), will apply on next check cycle`);
    }
  })();
}

function stopUpdateChecks(): void {
  if (G.updateCheckInterval) { clearInterval(G.updateCheckInterval); G.updateCheckInterval = null; }
}

// ─── Per-master WebSocket connection ─────────────────────────────────────

export function connectMaster(m: MasterConnection): void {
  if (m.retired) {
    log.info(`[${m.serverUrl}] connectMaster: slot is retired — not connecting`);
    return;
  }
  // One master, one socket — enforced where sockets are CREATED.
  //
  // This guard is the root fix for the fleet-wide reconnect loop. Without it,
  // anything that calls connectMaster on an already-connected slot opens a second
  // socket, and the `open` handler's `m.ws = ws` then discards the only reference
  // to the first one. That orphan cannot be closed by us — we no longer know it
  // exists — so the MASTER became the only party able to close it. That is why
  // masters grew a supersede-on-register close, why closing it fed a 1.1s
  // reconnect loop, and why before any such close existed one host accumulated
  // 10,196 open sockets until every child_process.spawn failed with `spawn EBADF`.
  //
  // Refusing here removes the orphan rather than arranging for someone else to
  // clean it up: no second socket, nothing to supersede, no master-side
  // prosthesis needed. See docs/MCP-Improvements/REPORT-v17-master-socket-obligations.md.
  //
  // CONNECTING counts. connectAllMasters() starts every slot in one tick, so a
  // readyState===OPEN-only test would let two attempts through before either
  // finishes its handshake — which is precisely the boot case.
  if (m.ws && (m.ws.readyState === WebSocket.OPEN || m.ws.readyState === WebSocket.CONNECTING)) {
    log.debug(
      `[${m.serverUrl}] connectMaster: a socket is already ` +
      `${m.ws.readyState === WebSocket.OPEN ? 'open' : 'connecting'} — not opening a second`,
    );
    return;
  }
  // Every attempt gets its own epoch. The callbacks below capture it, so an
  // earlier attempt's close/error/timeout cannot touch this slot once a newer
  // attempt — or `disconnectMaster` — has moved past it.
  m.wsEpoch = (m.wsEpoch ?? 0) + 1;
  const epoch = m.wsEpoch;
  const stale = () => m.wsEpoch !== epoch;
  log.info(`[${m.serverUrl}] connectMaster: attempting (currentMode=${m.connectionMode}, reconnectDelay=${m.wsReconnectDelay}ms)`);
  try {
    const serverHost = new URL(m.serverUrl).hostname;
    // Per-master WS port. Sound Suite uses 3002 (relay listens on a dedicated
    // port). Fantom MCP accepts WS upgrades on the same port as its HTTP API
    // (e.g. 3848). Default keeps Sound Suite single-master deployments
    // unchanged.
    // `m.wsPort` arrives ONLY in a master-identity frame, so it is undefined for
    // the whole first-connect window — and for as long as a master cannot identify
    // itself at all. The `?? 3002` default is therefore a GUESS, and on a host that
    // runs more than one master it is a dangerous one: `serverHost` is the same for
    // every master on that host, so the ws port is the only thing separating their
    // endpoints, and an unknown port silently resolves onto Sound Suite's relay.
    const portExplicit = m.wsPort !== undefined;
    const wsPort = m.wsPort ?? 3002;
    const wsUrl = `ws://${serverHost}:${wsPort}/sidecar`;

    if (!portExplicit) {
      // If another master on THIS host holds that exact port explicitly, the guess
      // is not merely unverified — it is certainly wrong, and dialling it would
      // register this sidecar on someone else's master under the same agentUrl.
      // The master supersedes per agentUrl, so the two slots then evict each other
      // roughly every POLL_INTERVAL, and the loser's WS never survives long enough
      // for its 5s heartbeat to fire even once: `mode: 'websocket'` with
      // `lastHeartbeatAt: null` and a config write every ~3.5s. Refuse instead, and
      // say what is missing.
      const owner = [...state.masters.values()].find((o) => {
        if (o === m || o.retired || o.wsPort !== wsPort) return false;
        try { return new URL(o.serverUrl).hostname === serverHost; } catch { return false; }
      });
      if (owner) {
        log.warn(
          `[${m.serverUrl}] No wsPort known for this master, and the default ${wsPort} ` +
          `belongs to ${owner.serverUrl} on the same host — refusing to dial it. ` +
          `Waiting for a master-identity frame to supply the real wsPort (set it in ` +
          `/setup, or fix the master's host-provisioning row so it can identify itself).`,
        );
        scheduleReconnect(m);
        m.connectionStatus = `Needs wsPort — ${wsPort} belongs to ${owner.serverUrl}`;
        return;
      }
    }
    const agentUrl = getAgentUrl();

    // One master, one socket. Two slots keyed differently but dialling the SAME
    // ws endpoint are the same master process, and the master supersedes per
    // agentUrl rather than per slot: each slot's register closes the other's
    // socket, each close schedules its own reconnect, and the pair ping-pongs on
    // the 1s backoff forever (6 registrations in 5s, reproduced in
    // src/lib/gpu/__tests__/sidecar-master-rekey.test.ts; seen from the master
    // side as 221 reconnects / 90s in mcpfantom's soundsuiteMaster.ts, where the
    // cause was recorded as unknown). Refuse the redundant socket instead. The
    // holder may well be the alias rather than the canonical key — we do not
    // guess which is "right", we just decline to open a second connection to a
    // master we are already connected to, and say so once.
    for (const other of state.masters.values()) {
      if (other === m || other.retired) continue;
      // `wsUrl` is a CLAIM on the endpoint, set below before the socket opens and
      // cleared again the moment the connection ends (close handler,
      // fallbackToHttp, disconnectMaster). Checking `readyState === OPEN` instead
      // would miss the case that matters most: `connectAllMasters()` starts every
      // disconnected slot in the same tick, so at boot neither duplicate has an
      // open socket yet and both would proceed.
      if (other.wsUrl !== wsUrl) continue;
      log.warn(
        `[${m.serverUrl}] Duplicate master slot: ${wsUrl} is already connected as ` +
        `${other.serverUrl}. Not opening a second socket (it would ping-pong: the ` +
        `master supersedes per agentUrl, not per slot). Remove one of the two ` +
        `entries in /setup.`,
      );
      m.wsReconnectDelay = Math.max(m.wsReconnectDelay, 60_000);
      scheduleReconnect(m);
      // After scheduleReconnect, which writes its own "Reconnecting in Ns"
      // status: the operator needs to see WHY this slot is idle.
      m.connectionStatus = `Duplicate of ${other.serverUrl} — not connecting`;
      return;
    }
    m.wsUrl = wsUrl;

    log.info(`[${m.serverUrl}] Connecting to ${wsUrl} (agentUrl: ${agentUrl})...`);
    const headers: Record<string, string> = {};
    if (m.authToken) headers['Authorization'] = `Bearer ${m.authToken}`;
    const ws = new WebSocket(wsUrl, { headers });

    const connectTimeout = setTimeout(async () => {
      if (stale()) {
        // A newer attempt or a teardown owns this slot now. Release the socket
        // this attempt opened — nothing else references it — and stop.
        try { ws.terminate(); } catch { /* ignore */ }
        return;
      }
      log.warn(`[${m.serverUrl}] WebSocket connect timed out, falling back to HTTP gossip`);
      ws.terminate();
      await fallbackToHttp(m);
    }, 5_000);

    ws.on('open', () => {
      clearTimeout(connectTimeout);
      if (stale()) {
        log.info(`[${m.serverUrl}] WebSocket opened for a superseded attempt — closing it`);
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
      log.info(`[${m.serverUrl}] WebSocket connected`);
      m.unreachable = false;
      m.httpHeartbeatFailCount = 0;
      m.wsReconnectDelay = 1000;
      m.ws = ws;
      m.connectionMode = 'websocket';
      m.connectionStatus = 'Connected via WebSocket';
      if (!G.firstConnectEmitted.has(m.serverUrl)) {
        G.firstConnectEmitted.add(m.serverUrl);
        emitBootEvent(`Connected to master ${m.serverUrl} via ws`, { url: m.serverUrl, transport: 'ws' });
      }
      // Aggregate connectionStatus is "best-of" the masters
      state.connectionStatus = 'Connected via WebSocket';
      stopHttpHeartbeat(m);

      startUpdateChecks();

      ws.send(JSON.stringify({
        type: 'register',
        agentUrl,
        hostname: getDisplayHostname(),
        containers: getRegisteredContainers(),
      }));

      if (m.heartbeatTimer) clearInterval(m.heartbeatTimer);
      m.wsHeartbeatFailCount = 0;

      // Heartbeat ONCE immediately, then on the interval.
      //
      // The interval below is 5s and every new socket resets it, so a connection
      // that is superseded more often than every 5s never fires it even once. The
      // result was a slot reporting `connectionMode: 'websocket'` with
      // `lastHeartbeatAt: null` and `consecutiveFailures: 0` — all three accurate,
      // and together a host the master believed was live while it had never said
      // anything. Registering and then going silent is worse than reporting
      // disconnected. An immediate beat also gives the master real status at
      // connect time instead of 5s later.
      const beat = async (): Promise<void> => {
        if (stale() || ws.readyState !== WebSocket.OPEN) return;
        try {
          const statusData = await buildFullStatus();
          if (stale() || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            type: 'heartbeat',
            containers: getRegisteredContainers(),
            activeRequests: getTotalActiveRequests(),
            statusData,
          }));
          m.wsHeartbeatFailCount = 0;
          m.lastHeartbeatAt = Date.now();
        } catch (err) {
          m.wsHeartbeatFailCount++;
          log.error(`[${m.serverUrl}] WS heartbeat failed (${m.wsHeartbeatFailCount}x): ${(err as Error).message}`);
          if (m.wsHeartbeatFailCount >= 3) {
            log.warn(`[${m.serverUrl}] WS heartbeat failed 3 times, forcing reconnect`);
            ws.terminate();
          }
        }
      };
      void beat();

      m.heartbeatTimer = setInterval(async () => {
        if (ws.readyState !== WebSocket.OPEN) {
          log.warn(`[${m.serverUrl}] WS heartbeat: socket not open, skipping`);
          return;
        }
        try {
          const statusData = await buildFullStatus();
          ws.send(JSON.stringify({
            type: 'heartbeat',
            containers: getRegisteredContainers(),
            activeRequests: getTotalActiveRequests(),
            statusData,
          }));
          m.wsHeartbeatFailCount = 0;
          m.lastHeartbeatAt = Date.now();
        } catch (err) {
          m.wsHeartbeatFailCount++;
          log.error(`[${m.serverUrl}] WS heartbeat failed (${m.wsHeartbeatFailCount}x): ${(err as Error).message}`);
          if (m.wsHeartbeatFailCount >= 3) {
            log.warn(`[${m.serverUrl}] WS heartbeat failed 3 times, forcing reconnect`);
            ws.terminate();
          }
        }
      }, HEARTBEAT_INTERVAL);
    });

    ws.on('message', async (data: WebSocket.Data) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'registered') {
        log.info(`[${m.serverUrl}] Registration acknowledged by server`);
        if (typeof msg.serverVersion === 'string') {
          m.lastSeenServerVersion = msg.serverVersion;
        }
      } else if (msg.type === 'master-identity') {
        // Master is announcing its canonical URL (and optional WS port).
        // Persist so a sidecar reboot — even after docker volume GC — can
        // recover the master URL without operator intervention. Idempotent:
        // operating on the same URL twice is a no-op. If only the trailing
        // slash differs from the current key we rekey the slot in place.
        const canonical = typeof msg.canonicalUrl === 'string' ? msg.canonicalUrl : null;
        const wsPort = typeof msg.wsPort === 'number' ? msg.wsPort : undefined;
        if (canonical) {
          const normalized = canonical.replace(/\/+$/, '');
          try {
            // THIS is where `masters` grew duplicates. The old code rekeyed only
            // when the difference was a trailing slash, and otherwise called
            // `ensureMaster(normalized)` — adding a SECOND slot for the master
            // we are already talking to. Both slots then register with the same
            // agentUrl, the master supersedes per agentUrl rather than per slot,
            // so each slot's register closes the other's socket and each close
            // schedules its own reconnect: a ~1 s supersede ping-pong. Measured
            // at 6 registrations in 5 s in
            // src/lib/gpu/__tests__/sidecar-master-rekey.test.ts, and
            // independently at 221 reconnects / 90 s from the master side
            // (mcpfantom soundsuiteMaster.ts, SUPERSEDED_GRACE_MS comment,
            // which recorded the symptom with the cause unknown).
            //
            // One master is one slot. Never add a slot from an identity frame.
            // Record the master's own claim about its identity BEFORE dedup, so a
            // slot that announces the same canonical URL as another can be
            // recognised as the same master even when the two dialled completely
            // different addresses (multi-homed master: LAN + VPN).
            m.announcedCanonicalUrl = normalized;
            const twin = [...state.masters.values()].find(
              (o) => o !== m && !o.retired && o.announcedCanonicalUrl === normalized,
            );
            if (twin) {
              log.warn(
                `[${m.serverUrl}] Same master as ${twin.serverUrl}: both announced ` +
                `canonical URL ${normalized}. Two slots for one master register with ` +
                `the same agentUrl and the master supersedes per agentUrl, so they ` +
                `evict each other indefinitely. Retiring ${twin.serverUrl}; keeping ` +
                `the key carrying this frame.`,
              );
              retireMaster(twin);
              saveConfig();
            }
            const existing = state.masters.get(normalized);
            if (existing && existing !== m) {
              // Two keys, one master — by construction, since this master says
              // `normalized` is its own canonical URL. Retire the duplicate
              // (socket closed, timers cleared, never reconnects) and keep the
              // slot whose socket is carrying this frame.
              log.warn(
                `[${m.serverUrl}] master-identity: ${normalized} is a second slot ` +
                `for THIS master — retiring the duplicate to stop the supersede ` +
                `ping-pong. Masters ${state.masters.size} → ${state.masters.size - 1}.`,
              );
              retireMaster(existing);
              saveConfig();
            } else if (m.serverUrl !== normalized && m.serverUrl.replace(/\/+$/, '') === normalized) {
              // Trailing-slash-only difference: re-key this slot in place.
              log.info(`[${m.serverUrl}] master-identity rekey → ${normalized}`);
              const res = rekeyMaster(m.serverUrl, normalized);
              if (res.ok) saveConfig();
              else log.warn(`[${m.serverUrl}] master-identity rekey → ${normalized} refused: ${res.reason}`);
            } else if (m.serverUrl !== normalized) {
              // The master announces a genuinely different URL. Do NOT adopt it
              // as this slot's key and do NOT add a slot: the key we are
              // connected on demonstrably works, and the announced one is
              // unverified. On a host whose master is sometimes behind a VPN a
              // wrong address takes the host dark and recovery means editing
              // config inside a container (see the startGossipClient comment and
              // docs/tasks/41-sidecar-address-drift.md).
              log.info(
                `[${m.serverUrl}] master-identity announced ${normalized}; keeping ` +
                `the key that is working (no second slot)`,
              );
            }
            if (wsPort !== undefined && m.wsPort !== wsPort) {
              m.wsPort = wsPort;
              saveConfig();
              log.info(`Master identified: ${m.serverUrl} (wsPort=${wsPort})`);
            }
          } catch (err) {
            log.warn(`master-identity handling failed for "${normalized}": ${(err as Error).message}`);
          }
        }
      } else if (msg.type === 'command') {
        state.wsCommandCount++;
        const action = msg.action as string;
        const id = msg.id as string;
        log.info(`[${m.serverUrl}] WS command received: ${action} (id: ${id})`);
        m.pendingCommands.set(id, { id, action, startedAt: Date.now() });
        try {
          const result = await executeCommand(m, {
            id,
            action,
            payload: msg as Record<string, unknown>,
          });
          m.pendingCommands.delete(id);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'result', id, ...result }));
          }
        } catch (err) {
          m.pendingCommands.delete(id);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'result', id, error: (err as Error).message }));
          }
        }
      } else if (msg.type === 'config-push' || msg.type === 'config') {
        // Some master deployments push config as a top-level frame, not as a
        // command. Route through the same handler.
        try {
          await executeCommand(m, {
            id: (msg.id as string) || `cfg-${Date.now()}`,
            action: 'config',
            payload: (msg.payload as Record<string, unknown>) || (msg as Record<string, unknown>),
          });
        } catch (err) {
          log.error(`[${m.serverUrl}] config-push handling failed: ${(err as Error).message}`);
        }
      }
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      clearTimeout(connectTimeout);
      // The close code is the only thing in this event that says WHO hung up,
      // and it was being discarded. Two masters — separate processes, separate
      // implementations — were observed dropping within 300 ms of each other
      // ~20 s after connecting, and nothing in either party's log could say
      // whether the peer closed, we closed, or the tunnel died underneath both.
      //   1000/1001 with a reason  → the peer closed on purpose (reason says why)
      //   1012                     → Sound Suite superseded this socket
      //   1006 (no close frame)    → TCP dropped: network / VPN / host NAT, not a peer
      // REPORT-v17: "instrument the relationship, not the components."
      const reason = reasonBuf?.length ? reasonBuf.toString() : '';
      const closeDesc =
        code === 1006 ? 'code=1006 (no close frame — connection dropped, not closed by peer)'
        : `code=${code}${reason ? ` reason="${reason}"` : ''}`;
      // This closure captures the socket that closed, but mutates the per-master
      // state `m`, which may by now point at a NEWER socket. Tearing down
      // unconditionally is a self-sustaining reconnect loop:
      //
      //   master closes the superseded socket -> this handler nulls m.ws (the
      //   LIVE one) -> the live socket is orphaned, still open, referenced by
      //   nothing -> mode flips to disconnected -> reconnect -> the master
      //   supersedes again -> repeat, leaking one socket per turn.
      //
      // Observed as `mode: websocket` with a heartbeat many minutes stale on a
      // 5s interval: state describing a connection nothing is using. The master
      // guards the mirror image of this race in src/lib/gpu/ws-relay.ts.
      //
      // `m.ws === null` must still fall through: that is the failed-handshake /
      // connect-timeout path, which genuinely needs the reconnect scheduled.
      // `m.ws !== ws` catches the case where a newer socket is already
      // installed. The epoch catches the two it cannot see: a manual
      // `disconnectMaster` (which nulls `m.ws` *before* this event lands, so the
      // `m.ws === null` fall-through below re-armed the very reconnect the
      // disconnect had just cancelled), and a slot that has been retired.
      if (stale()) {
        log.info(`[${m.serverUrl}] Closed socket belongs to a superseded attempt; nothing to do`);
        return;
      }
      if (m.ws && m.ws !== ws) {
        log.info(`[${m.serverUrl}] Superseded WebSocket closed; live connection retained`);
        return;
      }
      log.info(`[${m.serverUrl}] WebSocket disconnected — ${closeDesc}`);
      m.ws = null;
      // Release the endpoint claim so a slot that was standing down as a
      // duplicate can take this master over if we cannot get back.
      m.wsUrl = undefined;
      m.connectionMode = 'disconnected';
      m.connectionStatus = `WebSocket disconnected (${code === 1006 ? 'dropped, 1006' : `code ${code}`})`;
      if (m.heartbeatTimer) { clearInterval(m.heartbeatTimer); m.heartbeatTimer = null; }
      // A master that is gone cannot send the releases it still owes, and when
      // it reconnects it re-acquires from scratch. Holding its leases would
      // only inflate activeRequests and keep the idle timer disarmed.
      closeLeasesForOwner(m.serverUrl);
      // If no master is on WS, stop process-wide update checks.
      if (!anyWebSocketConnected()) stopUpdateChecks();
      startHttpHeartbeat(m);
      scheduleReconnect(m);
    });

    ws.on('error', async (err: Error) => {
      clearTimeout(connectTimeout);
      if (stale()) {
        try { ws.terminate(); } catch { /* ignore */ }
        return;
      }
      // A slot that has been reported unreachable keeps retrying on the capped
      // backoff, but stops logging an error every cycle — the whole point of
      // item 6 is that a dead entry reads as dead, not as noise.
      if (m.unreachable) log.debug(`[${m.serverUrl}] WebSocket error (unreachable): ${err.message || 'unknown'}`);
      else log.error(`[${m.serverUrl}] WebSocket error: ${err.message || 'unknown'}`);
      // Same identity rule as 'close': an error on a socket we have already
      // replaced must not disturb the live connection. Release it and stop.
      if (m.ws && m.ws !== ws) {
        log.info(`[${m.serverUrl}] Error on superseded WebSocket; terminating it only`);
        try { ws.terminate(); } catch { /* ignore */ }
        return;
      }
      if (!m.ws) {
        log.info(`[${m.serverUrl}] Falling back to HTTP gossip...`);
        ws.terminate();
        await fallbackToHttp(m);
      }
    });
  } catch (err) {
    log.error(`[${m.serverUrl}] WebSocket connect failed: ${(err as Error).message}`);
    fallbackToHttp(m);
  }
}

async function fallbackToHttp(m: MasterConnection): Promise<void> {
  // No WS on this endpoint any more — drop the claim (see connectMaster).
  m.wsUrl = undefined;
  m.connectionMode = 'http';
  m.connectionStatus = 'Connected via HTTP fallback';
  if (!anyWebSocketConnected()) state.connectionStatus = 'Connected via HTTP fallback';
  await sendHttpHeartbeat(m);
  startHttpHeartbeat(m);
  startUpdateChecks();
  log.info(`[${m.serverUrl}] Running in HTTP gossip mode (heartbeat + poll)`);
  if (!G.firstConnectEmitted.has(m.serverUrl)) {
    G.firstConnectEmitted.add(m.serverUrl);
    emitBootEvent(`Connected to master ${m.serverUrl} via http`, { url: m.serverUrl, transport: 'http' });
  }
  scheduleReconnect(m);
}

export function scheduleReconnect(m: MasterConnection): void {
  if (m.retired) return;
  if (m.wsReconnectTimer) clearTimeout(m.wsReconnectTimer);
  // Consecutive failures without a successful connect. Reported, not given up
  // on: a master that is merely rebooting must come back on its own.
  if (!m.unreachable && m.wsReconnectDelay >= UNREACHABLE_AFTER_DELAY_MS) {
    m.unreachable = true;
    log.warn(
      `[${m.serverUrl}] Master reported UNREACHABLE after repeated failures ` +
      `(backoff now ${Math.round(m.wsReconnectDelay / 1000)}s). Still retrying — ` +
      `unreported is not down, and unreachable is not gone. Per-cycle errors ` +
      `are demoted to debug until it answers.`,
    );
  }
  m.wsReconnectTimer = setTimeout(() => {
    m.wsReconnectTimer = null;
    // IDENTITY, not key. `state.masters.has(m.serverUrl)` was true for an
    // orphaned connection whose key had been taken over by another
    // MasterConnection, so the orphan reconnected and re-registered forever.
    if (m.retired) return;
    if (state.masters.get(m.serverUrl) !== m) {
      log.warn(
        `[${m.serverUrl}] Reconnect cancelled: this connection no longer owns ` +
        `its key (another slot does) — retiring the orphan`,
      );
      retireMaster(m);
      return;
    }
    connectMaster(m);
  }, m.wsReconnectDelay);
  m.connectionStatus = `Reconnecting in ${Math.round(m.wsReconnectDelay / 1000)}s...`;
  log.info(`[${m.serverUrl}] WS reconnect in ${m.wsReconnectDelay / 1000}s...`);
  // Exponential backoff, capped at 5 min. We never give up — if the master
  // is down at sidecar boot, this timer keeps firing until it comes back.
  // Cap raised from 30s to 300s so we're not hammering an offline master
  // every half-minute forever; ceiling keeps recovery latency bounded.
  m.wsReconnectDelay = Math.min(m.wsReconnectDelay * 2, 300_000);
}

export function disconnectMaster(m: MasterConnection): void {
  // Bump the epoch FIRST. The `ws.close()` below fires its close event
  // asynchronously, by which time `m.ws` is already null — and the close
  // handler's `m.ws === null` branch is the failed-handshake path, which
  // deliberately schedules a reconnect. Without this bump, disconnecting a
  // master re-armed the reconnect it had just cancelled.
  m.wsEpoch = (m.wsEpoch ?? 0) + 1;
  if (m.wsReconnectTimer) { clearTimeout(m.wsReconnectTimer); m.wsReconnectTimer = null; }
  if (m.heartbeatTimer) { clearInterval(m.heartbeatTimer); m.heartbeatTimer = null; }
  if (m.pollTimer) { clearInterval(m.pollTimer); m.pollTimer = null; }
  if (m.ws) {
    try { m.ws.close(); } catch { /* ignore */ }
    m.ws = null;
  }
  m.connectionMode = 'disconnected';
  m.pendingCommands.clear();
  m.wsUrl = undefined;
  // Process-wide update checks were only ever stopped from the close handler,
  // which now (correctly) returns early for a socket this teardown has already
  // invalidated. Stop them here so a manual disconnect of the last WS master
  // does not leave the interval armed.
  if (!anyWebSocketConnected()) stopUpdateChecks();
  log.info(`[${m.serverUrl}] Disconnected (manual)`);
}

/**
 * The ONLY safe way to take a slot out of the map. Tears the connection down
 * (socket closed, all three timers cleared, epoch bumped) and marks it retired
 * so nothing that fires late can revive it, THEN removes the key.
 *
 * Callers that just `state.masters.delete(url)` — or that replaced an entry with
 * a bare `set()` — leave a `MasterConnection` with a live socket, a live
 * heartbeat and a live reconnect chain referenced by nothing. See
 * docs/tasks/42-sidecar-master-slot-churn.md.
 */
export function retireMaster(m: MasterConnection): void {
  m.retired = true;
  disconnectMaster(m);
  if (state.masters.get(m.serverUrl) === m) removeMaster(m.serverUrl);
}

// ─── Fan-out wrappers ────────────────────────────────────────────────────

export function connectAllMasters(): void {
  if (state.masters.size === 0) {
    log.info('connectAllMasters: no masters configured');
    return;
  }
  for (const m of state.masters.values()) {
    if (m.connectionMode === 'disconnected') {
      connectMaster(m);
    }
  }
}

export function disconnectAllMasters(): void {
  for (const m of state.masters.values()) {
    disconnectMaster(m);
  }
  if (G.watchdogTimer) { clearInterval(G.watchdogTimer); G.watchdogTimer = null; }
  stopUpdateChecks();
}

// ─── Back-compat shims for legacy single-master callsites ────────────────
// instrumentation.ts, ws-connect/route.ts etc still call these names.

export function connectWebSocket(): void {
  connectAllMasters();
}

export function disconnectWebSocket(): void {
  disconnectAllMasters();
}

// ─── Connection watchdog ─────────────────────────────────────────────────

function startWatchdog(): void {
  if (G.watchdogTimer) return;
  G.watchdogTimer = setInterval(() => {
    for (const m of state.masters.values()) {
      if (m.retired) continue;
      const wsOk = m.ws?.readyState === WebSocket.OPEN;
      const httpOk = m.connectionMode === 'http';
      if (!wsOk && !httpOk && !m.wsReconnectTimer) {
        log.warn(`[${m.serverUrl}] Watchdog: not connected and no reconnect scheduled — triggering reconnect`);
        m.wsReconnectDelay = 1000;
        connectMaster(m);
      } else if (!wsOk && httpOk) {
        if (!m.wsReconnectTimer) {
          log.info(`[${m.serverUrl}] Watchdog: in HTTP fallback but no WS reconnect scheduled — scheduling`);
          scheduleReconnect(m);
        }
      }
    }
  }, 30_000);
}

// ─── Startup ──────────────────────────────────────────────────────────────

export async function startGossipClient(): Promise<void> {
  // Bootstrap any masters from legacy state.serverUrl if config.ts hasn't
  // populated state.masters yet (back-compat path).
  if (state.masters.size === 0 && state.serverUrl) {
    ensureMaster(state.serverUrl);
  }

  // DELIBERATELY NOT CALLED: initAgentAddress() / revalidateAgentUrl().
  //
  // Both replace the persisted address with a locally-detected one, which is
  // unsafe on a fleet whose master is sometimes on a VPN: the host is reachable
  // at a DIFFERENT address depending on the path (LAN vs Tailscale CGNAT vs VPN
  // DNS name), and the sidecar cannot know which network the master is on right
  // now. A wrong guess takes the host dark, and recovering it means editing
  // config inside a container on a machine that is by then unreachable.
  //
  // Only the master knows which path is in use, so the callback address is
  // OBSERVED master-side from the socket's peer address (src/lib/gpu/ws-relay.ts)
  // rather than declared here. See docs/tasks/41-sidecar-address-drift.md.

  // Connect FIRST so heartbeats flow during slow provisioning
  connectAllMasters();

  // Expire abandoned leases even on a process that never sees an acquire of
  // its own — openLease() also starts this, but a sidecar whose masters all
  // went away still needs the sweep to drain what they left behind.
  startSweeper();

  try {
    await autoProvision();
  } catch (err) {
    log.error(`Auto-provision failed: ${(err as Error).message}`);
  }

  startWatchdog();
}

/** Test seam: drive one HTTP heartbeat, the transport the master's
 *  `X-Sound-Suite-Master-Url` header rides on. Not used by product code. */
export async function __testSendHttpHeartbeat(m: MasterConnection): Promise<void> {
  await sendHttpHeartbeat(m);
}

// Helper exported for /api/masters routes — not exported above to avoid
// circular re-export conflicts.
export { ensureMaster, removeMaster };
