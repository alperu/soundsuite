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

const log = createLogger('gossip');

// Per-master "first successful connect" flag. Emits the boot event once per
// boot per master, not on every reconnect / heartbeat cycle.
const firstConnectEmitted = new Set<string>();

// Update-check is a process-wide concern, not per-master. Run it once against
// the first master only — the binary doesn't need N parallel update probes.
let updateCheckInterval: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

const PORT = parseInt(process.env.AGENT_PORT || process.env.PORT || '8098', 10);
const HEARTBEAT_INTERVAL = 5_000;  // 5s heartbeat
const POLL_INTERVAL = 3_000;       // 3s poll when WS is down

// ─── Agent URL detection ──────────────────────────────────────────────────

export function getAgentUrl(): string {
  if (process.env.AGENT_URL) return process.env.AGENT_URL;
  if (state.savedAgentUrl) return state.savedAgentUrl;
  if (process.env.EXTERNAL_IP) return `http://${process.env.EXTERNAL_IP}:${PORT}`;

  const interfaces = os.networkInterfaces();
  let fallback: string | null = null;

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('172.17.') || iface.address.startsWith('172.18.')) {
        if (!fallback) fallback = iface.address;
        continue;
      }
      return `http://${iface.address}:${PORT}`;
    }
  }
  return `http://${fallback || '127.0.0.1'}:${PORT}`;
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
 * Parse `X-Sound-Suite-Master-Url` header from any master→sidecar response.
 * Idempotent: only adds when URL is new. Persists via saveConfig() so a
 * subsequent boot (e.g. after docker volume GC) recovers the master URL
 * without operator intervention.
 */
function absorbMasterUrlHeader(headers: http.IncomingHttpHeaders, sourceLabel: string): void {
  const raw = headers['x-sound-suite-master-url'];
  const masterUrl = Array.isArray(raw) ? raw[0] : raw;
  if (typeof masterUrl !== 'string' || masterUrl.length === 0) return;
  const normalized = masterUrl.replace(/\/+$/, '');
  if (state.masters.has(normalized)) return;
  try {
    ensureMaster(normalized, {});
    saveConfig();
    log.info(`Master self-identified via header (${sourceLabel}): ${normalized}`);
  } catch (err) {
    log.warn(`Failed to absorb master URL header "${normalized}": ${(err as Error).message}`);
  }
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
    case 'acquire': return handleAcquire(role);
    case 'release': return handleRelease(role);
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
        if (m.serverUrl !== payload.serverUrl) {
          log.info(`[${m.serverUrl}] Master pushed serverUrl rename → ${payload.serverUrl}`);
          rekeyMaster(m.serverUrl, payload.serverUrl);
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

    absorbMasterUrlHeader(respHeaders, 'heartbeat');

    if (status === 200) {
      if (m.httpHeartbeatFailCount > 0) {
        log.info(`[${m.serverUrl}] HTTP heartbeat recovered after ${m.httpHeartbeatFailCount} failures`);
      }
      m.httpHeartbeatFailCount = 0;
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
    log.error(`[${m.serverUrl}] HTTP heartbeat failed (${m.httpHeartbeatFailCount}x): ${(err as Error).message}`);
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

    absorbMasterUrlHeader(respHeaders, 'poll');

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
      absorbMasterUrlHeader(respHeaders, 'result');
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
  if (updateCheckInterval) return;
  updateCheckInterval = setInterval(async () => {
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
  if (updateCheckInterval) { clearInterval(updateCheckInterval); updateCheckInterval = null; }
}

// ─── Per-master WebSocket connection ─────────────────────────────────────

export function connectMaster(m: MasterConnection): void {
  log.info(`[${m.serverUrl}] connectMaster: attempting (currentMode=${m.connectionMode}, reconnectDelay=${m.wsReconnectDelay}ms)`);
  try {
    const serverHost = new URL(m.serverUrl).hostname;
    // Per-master WS port. Sound Suite uses 3002 (relay listens on a dedicated
    // port). Fantom MCP accepts WS upgrades on the same port as its HTTP API
    // (e.g. 3848). Default keeps Sound Suite single-master deployments
    // unchanged.
    const wsPort = m.wsPort ?? 3002;
    const wsUrl = `ws://${serverHost}:${wsPort}/sidecar`;
    const agentUrl = getAgentUrl();

    log.info(`[${m.serverUrl}] Connecting to ${wsUrl} (agentUrl: ${agentUrl})...`);
    const headers: Record<string, string> = {};
    if (m.authToken) headers['Authorization'] = `Bearer ${m.authToken}`;
    const ws = new WebSocket(wsUrl, { headers });

    const connectTimeout = setTimeout(async () => {
      log.warn(`[${m.serverUrl}] WebSocket connect timed out, falling back to HTTP gossip`);
      ws.terminate();
      await fallbackToHttp(m);
    }, 5_000);

    ws.on('open', () => {
      clearTimeout(connectTimeout);
      log.info(`[${m.serverUrl}] WebSocket connected`);
      m.wsReconnectDelay = 1000;
      m.ws = ws;
      m.connectionMode = 'websocket';
      m.connectionStatus = 'Connected via WebSocket';
      if (!firstConnectEmitted.has(m.serverUrl)) {
        firstConnectEmitted.add(m.serverUrl);
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
            // If the current connection's key differs only after normalization,
            // re-key this slot rather than creating a 2nd master entry.
            if (m.serverUrl !== normalized && m.serverUrl.replace(/\/+$/, '') === normalized) {
              log.info(`[${m.serverUrl}] master-identity rekey → ${normalized}`);
              rekeyMaster(m.serverUrl, normalized);
            }
            const existing = state.masters.get(normalized);
            const portChanged = wsPort !== undefined && existing?.wsPort !== wsPort;
            if (!existing || portChanged) {
              ensureMaster(normalized, wsPort !== undefined ? { wsPort } : {});
              saveConfig();
              log.info(`Master identified: ${normalized}${wsPort !== undefined ? ` (wsPort=${wsPort})` : ''}`);
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

    ws.on('close', () => {
      clearTimeout(connectTimeout);
      log.info(`[${m.serverUrl}] WebSocket disconnected`);
      m.ws = null;
      m.connectionMode = 'disconnected';
      m.connectionStatus = 'WebSocket disconnected';
      if (m.heartbeatTimer) { clearInterval(m.heartbeatTimer); m.heartbeatTimer = null; }
      // If no master is on WS, stop process-wide update checks.
      if (!anyWebSocketConnected()) stopUpdateChecks();
      startHttpHeartbeat(m);
      scheduleReconnect(m);
    });

    ws.on('error', async (err: Error) => {
      clearTimeout(connectTimeout);
      log.error(`[${m.serverUrl}] WebSocket error: ${err.message || 'unknown'}`);
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
  m.connectionMode = 'http';
  m.connectionStatus = 'Connected via HTTP fallback';
  if (!anyWebSocketConnected()) state.connectionStatus = 'Connected via HTTP fallback';
  await sendHttpHeartbeat(m);
  startHttpHeartbeat(m);
  startUpdateChecks();
  log.info(`[${m.serverUrl}] Running in HTTP gossip mode (heartbeat + poll)`);
  if (!firstConnectEmitted.has(m.serverUrl)) {
    firstConnectEmitted.add(m.serverUrl);
    emitBootEvent(`Connected to master ${m.serverUrl} via http`, { url: m.serverUrl, transport: 'http' });
  }
  scheduleReconnect(m);
}

export function scheduleReconnect(m: MasterConnection): void {
  if (m.wsReconnectTimer) clearTimeout(m.wsReconnectTimer);
  // Master may have been removed between scheduling and firing
  m.wsReconnectTimer = setTimeout(() => {
    if (!state.masters.has(m.serverUrl)) return;
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
  if (m.wsReconnectTimer) { clearTimeout(m.wsReconnectTimer); m.wsReconnectTimer = null; }
  if (m.heartbeatTimer) { clearInterval(m.heartbeatTimer); m.heartbeatTimer = null; }
  if (m.pollTimer) { clearInterval(m.pollTimer); m.pollTimer = null; }
  if (m.ws) {
    try { m.ws.close(); } catch { /* ignore */ }
    m.ws = null;
  }
  m.connectionMode = 'disconnected';
  m.pendingCommands.clear();
  log.info(`[${m.serverUrl}] Disconnected (manual)`);
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
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
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
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    for (const m of state.masters.values()) {
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

  // Connect FIRST so heartbeats flow during slow provisioning
  connectAllMasters();

  try {
    await autoProvision();
  } catch (err) {
    log.error(`Auto-provision failed: ${(err as Error).message}`);
  }

  startWatchdog();
}

// Helper exported for /api/masters routes — not exported above to avoid
// circular re-export conflicts.
export { ensureMaster, removeMaster };
