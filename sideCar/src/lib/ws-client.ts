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
import { state, ensureMaster, rekeyMaster, removeMaster, type MasterConnection } from './state';
import { handleAcquire, handleRelease, handleStart, handleStop, handleStatus, getTotalActiveRequests } from './handlers';
import { switchMode, provisionContainers, getAllContainerStates, containersForMode, ensureContainerForRole } from './containers';
import { discoverGpus } from './gpu';
import { getContainerState, pullImage, createContainer, startContainer, dockerRequest, getDockerHostName } from './docker';
import { ollamaList, ollamaPull, ollamaLoad, waitForOllama } from './ollama-api';
import { saveConfig } from './config';
import { createLogger } from './logger';
import { checkForUpdate, performUpdate } from './self-update';
import { tasks } from './task-tracker';

const log = createLogger('gossip');

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
): Promise<{ status: number; body: string }> {
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
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
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
    case 'start': {
      if (role) {
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
      if (rolesNowOptOut.length > 0) {
        const { stopContainer } = await import('./docker');
        for (const role of rolesNowOptOut) {
          const def = state.registry[role];
          if (!def) continue;
          const active = state.perRole[role]?.activeRequests ?? 0;
          if (active > 0) continue;
          try {
            const cs = await getContainerState(def.containerName);
            if (cs.status === 'running') {
              await stopContainer(def.containerName);
              log.info(`Auto-stopped ${def.containerName} — minOnline transitioned to 0`);
            }
          } catch { /* best-effort */ }
        }
      }
      const modelChangedRoles: string[] = [];
      if (payload.registry) {
        for (const [r, overrides] of Object.entries(payload.registry as Record<string, unknown>)) {
          if (state.registry[r]) {
            const oldModel = state.registry[r].model;
            Object.assign(state.registry[r], overrides);
            state.pullFailCount[r] = 0;
            if (state.registry[r].model && state.registry[r].model !== oldModel) {
              modelChangedRoles.push(r);
            }
          }
        }
      }
      saveConfig();
      if (modelChangedRoles.length > 0) {
        log.info(`Config push changed models for: ${modelChangedRoles.join(', ')} — triggering ensureOllamaModel`);
        for (const r of modelChangedRoles) {
          handleAcquire(r).catch(err => log.warn(`Auto-acquire after config push failed for ${r}: ${(err as Error).message}`));
        }
      }
      return { ok: true, idleTimeouts: state.idleTimeouts, containerName: state.CONTAINER_NAME };
    }
    case 'pullModel': {
      const pullRole = payload.role as string;
      const def = state.registry[pullRole];
      if (!def) return { error: `Unknown role: ${pullRole}` };
      if (!def.model) return { error: `No model configured for ${pullRole}` };

      if (def.type === 'vllm') {
        try {
          await pullImage(def.image);
        } catch (err) {
          return { error: `Image pull failed: ${(err as Error).message}` };
        }
        await ensureContainerForRole(pullRole);
        const csv = await getContainerState(def.containerName);
        if (csv.status !== 'running') {
          await startContainer(def.containerName);
        }
        return { ok: true, model: def.model, container: def.containerName, message: `${def.model} image pulled and container started — vLLM will download model from HuggingFace on first request (cached afterwards)` };
      }

      if (def.type !== 'ollama') return { error: `${pullRole} is not an Ollama or vLLM container` };
      const cs = await getContainerState(def.containerName);
      if (cs.status !== 'running') return { error: `Container ${def.containerName} is not running` };
      await ollamaPull(def.port, def.model);
      if (!state.modelLoading.has(pullRole)) {
        state.modelLoading.add(pullRole);
        ollamaLoad(def.port, def.model).finally(() => {
          state.modelLoading.delete(pullRole);
        });
      }
      return { ok: true, model: def.model, container: def.containerName, message: `${def.model} pulled & loading into VRAM` };
    }
    case 'loadModel': {
      const loadRole = payload.role as string;
      const def = state.registry[loadRole];
      if (!def) return { error: `Unknown role: ${loadRole}` };
      if (!def.model) return { error: `No model configured for ${loadRole}` };

      if (def.type === 'vllm') {
        const csv = await getContainerState(def.containerName);
        if (csv.status !== 'running') {
          await startContainer(def.containerName);
          return { ok: true, model: def.model, container: def.containerName, message: `${def.containerName} started — vLLM is loading ${def.model}` };
        }
        return { ok: true, model: def.model, container: def.containerName, message: `${def.containerName} already running` };
      }

      if (def.type !== 'ollama') return { error: `${loadRole} is not an Ollama or vLLM container` };
      const cs = await getContainerState(def.containerName);
      if (cs.status !== 'running') return { error: `Container ${def.containerName} is not running` };
      const loaded = await ollamaLoad(def.port, def.model);
      if (!loaded) return { error: `Failed to load ${def.model} into VRAM` };
      return { ok: true, model: def.model, container: def.containerName, message: `${def.model} loaded into VRAM` };
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

          if (!state.modelLoading.has(role)) {
            state.modelLoading.add(role);
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
              state.modelLoading.delete(role);
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
    const { status, body: responseBody } = await httpPost(
      `${m.serverUrl}/api/admin/gpu/sidecars/heartbeat`,
      fullStatus,
      m.authToken,
    );

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
    const { status, body: responseBody } = await httpPost(
      `${m.serverUrl}/api/admin/gpu/sidecars/poll`,
      { agentUrl: getAgentUrl() },
      m.authToken,
    );

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
      await httpPost(
        `${m.serverUrl}/api/admin/gpu/sidecars/result`,
        { commandId, result: result || {}, error },
        m.authToken,
      );
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
  m.wsReconnectDelay = Math.min(m.wsReconnectDelay * 2, 30_000);
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
