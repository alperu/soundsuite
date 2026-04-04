/**
 * Gossip Client — Sidecar ↔ Server Communication
 *
 * All connections are OUTBOUND from sidecar. Server never initiates.
 *
 * Primary:  WebSocket to server:3002 (real-time bidirectional)
 * Fallback: HTTP heartbeat to server:3000 (polls commands piggybacked on heartbeat)
 *
 * Heartbeats carry full status so the server never needs to query the sidecar.
 * Commands flow: server queues → sidecar picks up via WS push or HTTP poll.
 */

import os from 'os';
import http from 'http';
import https from 'https';
import WebSocket from 'ws';
import { state } from './state';
import { handleAcquire, handleRelease, handleStart, handleStop, handleStatus, getTotalActiveRequests } from './handlers';
import { switchMode, provisionContainers, getAllContainerStates, containersForMode } from './containers';
import { discoverGpus } from './gpu';
import { getContainerState, pullImage, createContainer, startContainer, dockerRequest, getDockerHostName } from './docker';
import { ollamaList, ollamaPull, ollamaLoad, waitForOllama } from './ollama-api';
import { saveConfig } from './config';
import { createLogger } from './logger';
import { checkForUpdate, performUpdate } from './self-update';
import { tasks } from './task-tracker';

const log = createLogger('gossip');

let updateCheckInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let connectionMode: 'websocket' | 'http' | null = null;

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

/**
 * Get a meaningful hostname for display.
 * Inside Docker, os.hostname() returns the container ID (e.g. "41972a76484b").
 * Use SIDECAR_HOSTNAME env var if set, otherwise detect if we're in Docker
 * and use a friendlier name.
 */
function getDisplayHostname(): string {
  if (process.env.SIDECAR_HOSTNAME) return process.env.SIDECAR_HOSTNAME;
  // Try Docker host's actual hostname (fetched via GET /info during initDocker)
  const dockerHostName = getDockerHostName();
  if (dockerHostName) return dockerHostName;
  if (process.env.COMPUTERNAME) return process.env.COMPUTERNAME; // Windows via Docker env passthrough
  const hostname = os.hostname();
  // Docker container IDs are 12+ hex chars — detect and replace with a friendlier name
  if (/^[0-9a-f]{12,}$/.test(hostname)) {
    // Inside Docker — use the external IP as identifier if available
    const ip = process.env.EXTERNAL_IP;
    return ip ? `gpu-${ip.split('.').pop()}` : `sidecar-${hostname.substring(0, 8)}`;
  }
  return hostname;
}

function getRegisteredContainers(): string[] {
  return Object.values(state.registry).map((d) => d.containerName);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

function httpPost(url: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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

  // Calculate total free VRAM for fleet routing decisions
  const freeVram = (gpus as any[]).reduce((sum, g) => sum + (g.memoryFree || 0), 0);
  const totalVram = (gpus as any[]).reduce((sum, g) => sum + (g.memoryTotal || 0), 0);

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
    freeVram,    // total free GPU memory in MB — for fleet routing
    totalVram,   // total GPU memory in MB
    wsConnected: connectionMode === 'websocket',
    containerNames: getRegisteredContainers(),
    tasks: tasks.getAll(),
  };
}

// ─── Command execution ────────────────────────────────────────────────────

async function executeCommand(cmd: { id: string; action: string; payload?: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const action = cmd.action.replace(/^\//, '');
  const payload = cmd.payload || {};
  const role = payload.role as string | undefined;

  log.info(`Executing command: ${action} (id: ${cmd.id})`);

  switch (action) {
    case 'acquire': return handleAcquire(role);
    case 'release': return handleRelease(role);
    case 'start': {
      // VRAM check before starting
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
      if (!state.serverUrl) return { error: 'No server URL configured' };
      const { available, version } = await checkForUpdate(state.serverUrl);
      if (!available) return { ok: true, message: 'Already up to date' };
      const updated = await performUpdate(state.serverUrl);
      return updated ? { ok: true, message: `Updating to v${version}` } : { error: 'Update failed' };
    }
    case 'config': {
      if (payload.idleTimeouts) Object.assign(state.idleTimeouts, payload.idleTimeouts);
      if (payload.containerName) state.CONTAINER_NAME = payload.containerName as string;
      const modelChangedRoles: string[] = [];
      if (payload.registry) {
        for (const [r, overrides] of Object.entries(payload.registry as Record<string, unknown>)) {
          if (state.registry[r]) {
            const oldModel = state.registry[r].model;
            Object.assign(state.registry[r], overrides);
            // Reset pull failure counter when config changes for a role
            state.pullFailCount[r] = 0;
            if (state.registry[r].model && state.registry[r].model !== oldModel) {
              modelChangedRoles.push(r);
            }
          }
        }
      }
      saveConfig();
      // Fire-and-forget: ensure new models are pulled for roles whose model changed
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
      if (def.type !== 'ollama') return { error: `${pullRole} is not an Ollama container` };
      if (!def.model) return { error: `No model configured for ${pullRole}` };
      const cs = await getContainerState(def.containerName);
      if (cs.status !== 'running') return { error: `Container ${def.containerName} is not running` };
      await ollamaPull(def.port, def.model);
      // Auto-load into VRAM after pull
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
      if (def.type !== 'ollama') return { error: `${loadRole} is not an Ollama container` };
      if (!def.model) return { error: `No model configured for ${loadRole}` };
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
    if (gpus.length === 0) return { ok: true }; // No GPU info = let Docker decide

    const gpu = gpus[0];
    if (gpu.memoryFree < def.vram) {
      return {
        ok: false,
        reason: `Need ${def.vram}MB VRAM for ${role} but only ${gpu.memoryFree}MB free on ${gpu.name}`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: true }; // Can't check = proceed
  }
}

// ─── Auto-provision on startup ────────────────────────────────────────────

async function autoProvision(): Promise<void> {
  const allRoles = Object.keys(state.registry);
  const activeRoles = containersForMode(state.currentMode);
  log.info(`Auto-provisioning ALL roles: ${allRoles.join(', ')} (active for "${state.currentMode}": ${activeRoles.join(', ')})`);

  // Discover available VRAM upfront
  let availableVram = Infinity; // default: unlimited if GPU probe fails
  try {
    const gpus = await discoverGpus();
    if (gpus.length > 0) {
      availableVram = gpus[0].memoryFree;
      log.info(`Available VRAM: ${availableVram}MB on ${gpus[0].name}`);
    }
  } catch {
    log.warn('Could not discover GPU — will provision without VRAM checks');
  }

  // Deduplicate images — pull each unique image only once
  const pulledImages = new Set<string>();
  let vramUsed = 0;

  // Phase 1: Pull images + create containers for ALL roles (so mode switch is instant)
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

      // Pull image only if not already local and not already pulled this session
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

      // Create container (for ALL roles, not just active mode)
      log.info(`${role}: creating container ${def.containerName}...`);
      await createContainer(role);
      log.info(`${role}: container created`);
    } catch (err) {
      log.error(`${role}: provision failed: ${(err as Error).message}`);
    }
  }

  // Phase 2: Start + pull models ONLY for active mode roles, with VRAM checks
  // Sort active roles by VRAM (smallest first) to fit as many as possible
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
      if (!cs.exists) continue; // Creation failed in phase 1

      const alreadyRunning = cs.status === 'running';
      if (alreadyRunning) vramUsed += def.vram;

      // VRAM gate (only for containers that need starting)
      if (!alreadyRunning && vramUsed + def.vram > availableVram) {
        log.warn(`${role}: skipping start — needs ${def.vram}MB but only ${availableVram - vramUsed}MB free`);
        continue;
      }

      // For Ollama containers with a model: ensure pulled + loaded via HTTP API
      if (def.type === 'ollama' && def.model) {
        try {
          if (!alreadyRunning) {
            log.info(`${role}: starting container to pull model ${def.model}...`);
            await startContainer(def.containerName);
            vramUsed += def.vram;
          }
          await waitForOllama(def.port);

          // Check if model is on disk — pull if not
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
              // Post-pull verification
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

          // Fire-and-forget: load model into VRAM
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
        // Non-Ollama (e.g. vLLM) — start directly
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

// ─── HTTP heartbeat + command poll ────────────────────────────────────────

let httpHeartbeatFailCount = 0;
async function sendHttpHeartbeat(): Promise<void> {
  if (!state.serverUrl) return;

  try {
    const fullStatus = await buildFullStatus();
    const { status, body: responseBody } = await httpPost(
      `${state.serverUrl}/api/admin/gpu/sidecars/heartbeat`,
      fullStatus,
    );

    if (status === 200) {
      if (httpHeartbeatFailCount > 0) {
        log.info(`HTTP heartbeat recovered after ${httpHeartbeatFailCount} failures`);
      }
      httpHeartbeatFailCount = 0;
      // Heartbeat response may contain piggybacked commands
      try {
        const response = JSON.parse(responseBody);
        if (response.commands && Array.isArray(response.commands)) {
          for (const cmd of response.commands) {
            processCommand(cmd);
          }
        }
      } catch { /* parse error, ignore */ }
    } else {
      httpHeartbeatFailCount++;
      log.warn(`HTTP heartbeat returned ${status} (${httpHeartbeatFailCount}x)`);
    }
  } catch (err) {
    httpHeartbeatFailCount++;
    log.error(`HTTP heartbeat failed (${httpHeartbeatFailCount}x): ${(err as Error).message}`);
  }
}

async function pollForCommands(): Promise<void> {
  if (!state.serverUrl || connectionMode === 'websocket') return;

  try {
    const { status, body: responseBody } = await httpPost(
      `${state.serverUrl}/api/admin/gpu/sidecars/poll`,
      { agentUrl: getAgentUrl() },
    );

    if (status === 200) {
      const response = JSON.parse(responseBody);
      if (response.commands && Array.isArray(response.commands)) {
        for (const cmd of response.commands) {
          processCommand(cmd);
        }
      }
    }
  } catch (err) {
    // Silent — poll failures are expected when server is down
  }
}

/** Execute a command and report result back to server. */
function processCommand(cmd: { id: string; action: string; payload?: Record<string, unknown> }): void {
  executeCommand(cmd).then(async (result) => {
    log.info(`Command ${cmd.id} (${cmd.action}) completed`);
    await reportResult(cmd.id, result);
  }).catch(async (err) => {
    log.error(`Command ${cmd.id} (${cmd.action}) failed: ${(err as Error).message}`);
    await reportResult(cmd.id, undefined, (err as Error).message);
  });
}

async function reportResult(commandId: string, result?: unknown, error?: string): Promise<void> {
  if (!state.serverUrl) return;

  // If WS is connected, send result via WS (handled by the WS command flow)
  // For HTTP-polled commands, report via HTTP
  if (connectionMode !== 'websocket') {
    try {
      await httpPost(`${state.serverUrl}/api/admin/gpu/sidecars/result`, {
        commandId,
        result: result || {},
        error,
      });
    } catch (err) {
      log.error(`Failed to report result for ${commandId}: ${(err as Error).message}`);
    }
  }
}

function startHttpHeartbeat(): void {
  stopHttpHeartbeat();
  // Rich heartbeat every 5s
  heartbeatTimer = setInterval(() => sendHttpHeartbeat(), HEARTBEAT_INTERVAL);
  // Poll for commands every 3s (separate from heartbeat)
  pollTimer = setInterval(() => pollForCommands(), POLL_INTERVAL);
}

function stopHttpHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── Update checks ────────────────────────────────────────────────────────

function startUpdateChecks(): void {
  if (updateCheckInterval) clearInterval(updateCheckInterval);
  updateCheckInterval = setInterval(async () => {
    if (!state.serverUrl) return;
    const { available, version } = await checkForUpdate(state.serverUrl);
    if (available) {
      log.info(`Auto-updating to v${version}...`);
      await performUpdate(state.serverUrl);
    }
  }, 5 * 60 * 1000);

  (async () => {
    if (!state.serverUrl) return;
    const { available, version } = await checkForUpdate(state.serverUrl);
    if (available) {
      log.info(`Update available (v${version}), will apply on next check cycle`);
    }
  })();
}

function stopUpdateChecks(): void {
  if (updateCheckInterval) { clearInterval(updateCheckInterval); updateCheckInterval = null; }
}

// ─── WebSocket connection ─────────────────────────────────────────────────

export function connectWebSocket(): void {
  if (!state.serverUrl) return;
  log.info(`connectWebSocket: attempting connection (serverUrl=${state.serverUrl}, currentMode=${connectionMode}, reconnectDelay=${state.wsReconnectDelay}ms)`);
  try {
    const serverHost = new URL(state.serverUrl).hostname;
    const wsPort = 3002;
    const wsUrl = `ws://${serverHost}:${wsPort}/sidecar`;
    const agentUrl = getAgentUrl();

    log.info(`Connecting to ${wsUrl} (agentUrl: ${agentUrl})...`);
    const ws = new WebSocket(wsUrl);

    const connectTimeout = setTimeout(async () => {
      log.warn('WebSocket connect timed out, falling back to HTTP gossip');
      ws.terminate();
      await fallbackToHttp();
    }, 5_000);

    ws.on('open', () => {
      clearTimeout(connectTimeout);
      log.info('WebSocket connected');
      state.wsReconnectDelay = 1000;
      state.wsConnection = ws;
      connectionMode = 'websocket';
      state.connectionStatus = 'Connected via WebSocket';
      stopHttpHeartbeat(); // WS takes over

      startUpdateChecks();

      // Register with rich data
      ws.send(JSON.stringify({
        type: 'register',
        agentUrl,
        hostname: getDisplayHostname(),
        containers: getRegisteredContainers(),
      }));

      // Rich heartbeat via WS every 5s
      if (state.wsHeartbeatTimer) clearInterval(state.wsHeartbeatTimer);
      let wsHeartbeatFailCount = 0;
      state.wsHeartbeatTimer = setInterval(async () => {
        if (ws.readyState !== WebSocket.OPEN) {
          log.warn('WS heartbeat: socket not open, skipping');
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
          wsHeartbeatFailCount = 0;
        } catch (err) {
          wsHeartbeatFailCount++;
          log.error(`WS heartbeat failed (${wsHeartbeatFailCount}x): ${(err as Error).message}`);
          if (wsHeartbeatFailCount >= 3) {
            log.warn('WS heartbeat failed 3 times, forcing reconnect');
            ws.terminate();
          }
        }
      }, HEARTBEAT_INTERVAL);
    });

    ws.on('message', async (data: WebSocket.Data) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'registered') {
        log.info('Registration acknowledged by server');
      } else if (msg.type === 'command') {
        state.wsCommandCount++;
        const action = msg.action as string;
        log.info(`WS command received: ${action} (id: ${msg.id})`);
        try {
          const result = await executeCommand({
            id: msg.id as string,
            action,
            payload: msg as Record<string, unknown>,
          });
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ...result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, error: (err as Error).message }));
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(connectTimeout);
      log.info('WebSocket disconnected');
      state.wsConnection = null;
      connectionMode = null;
      state.connectionStatus = 'WebSocket disconnected';
      if (state.wsHeartbeatTimer) clearInterval(state.wsHeartbeatTimer);
      stopUpdateChecks();
      // Fall back to HTTP gossip + schedule WS reconnect
      startHttpHeartbeat();
      scheduleReconnect();
    });

    ws.on('error', async (err: Error) => {
      clearTimeout(connectTimeout);
      log.error(`WebSocket error: ${err.message || 'unknown'}`);
      if (!state.wsConnection) {
        log.info('Falling back to HTTP gossip...');
        ws.terminate();
        await fallbackToHttp();
      }
    });
  } catch (err) {
    log.error(`WebSocket connect failed: ${(err as Error).message}`);
    fallbackToHttp();
  }
}

async function fallbackToHttp(): Promise<void> {
  connectionMode = 'http';
  state.connectionStatus = 'Connected via HTTP fallback';
  // Send initial heartbeat (acts as registration)
  await sendHttpHeartbeat();
  startHttpHeartbeat();
  startUpdateChecks();
  log.info('Running in HTTP gossip mode (heartbeat + poll)');
  scheduleReconnect();
}

export function scheduleReconnect(): void {
  if (!state.serverUrl) return;
  if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
  state.wsReconnectTimer = setTimeout(() => connectWebSocket(), state.wsReconnectDelay);
  state.connectionStatus = `Reconnecting in ${Math.round(state.wsReconnectDelay / 1000)}s...`;
  log.info(`WS reconnect in ${state.wsReconnectDelay / 1000}s...`);
  state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 2, 30_000);
}

// ─── Connection watchdog ─────────────────────────────────────────────────
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!state.serverUrl) return;
    const wsOk = state.wsConnection?.readyState === WebSocket.OPEN;
    const httpOk = connectionMode === 'http';
    if (!wsOk && !httpOk && !state.wsReconnectTimer) {
      log.warn('Watchdog: not connected and no reconnect scheduled — triggering reconnect');
      state.wsReconnectDelay = 1000; // reset backoff
      connectWebSocket();
    } else if (!wsOk && httpOk) {
      // In HTTP mode — ensure WS reconnect is still being attempted
      if (!state.wsReconnectTimer) {
        log.info('Watchdog: in HTTP fallback but no WS reconnect scheduled — scheduling');
        scheduleReconnect();
      }
    }
  }, 30_000);
}

export function disconnectWebSocket(): void {
  if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
  if (state.wsHeartbeatTimer) clearInterval(state.wsHeartbeatTimer);
  stopHttpHeartbeat();
  stopUpdateChecks();
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (state.wsConnection) {
    state.wsConnection.close();
    state.wsConnection = null;
  }
  connectionMode = null;
  log.info('Disconnected (manual)');
}

// ─── Startup ──────────────────────────────────────────────────────────────

/**
 * Called from instrumentation.ts on sidecar boot.
 * Auto-provisions containers, then connects to server.
 */
export async function startGossipClient(): Promise<void> {
  // Connect to server FIRST — so heartbeats flow during provisioning
  if (state.serverUrl) {
    connectWebSocket();
  }

  // Then provision containers (slow, but server knows we're alive)
  try {
    await autoProvision();
  } catch (err) {
    log.error(`Auto-provision failed: ${(err as Error).message}`);
  }

  startWatchdog();
}
