import { state } from './state';
import { getContainerState, startContainer, stopContainer, removeContainer, createContainer, pullImage, getDockerMode, buildExpectedConfig, detectConfigDrift, isPortConflict, findContainerOnPort } from './docker';
import { ollamaList, ollamaShow, ollamaPull, ollamaLoad, waitForOllama } from './ollama-api';
import { loadGpuOnly } from './containers';
import { clearIdleTimerForRole, clearAllIdleTimers, startIdleTimerForRole, startIdleTimer } from './idle-timers';
import { getAllContainerStates } from './containers';
import { createLogger } from './logger';
import { recordDemandSample, getPeakDemand } from './demand-tracker';
import { tasks } from './task-tracker';
import fs from 'fs';
import path from 'path';
import os from 'os';

const log = createLogger('handlers');

// Get primary non-loopback IPv4 address
function getPrimaryIp(): string {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return 'unknown';
}

// Read version from package.json once at module load
let sidecarVersion = '2.0';
try {
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    sidecarVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '2.0';
  }
} catch { /* ignore */ }

/**
 * Ensure a container exists for a role: pull image + create container if needed.
 * Returns the container name.
 */
async function ensureContainer(role: string): Promise<string> {
  const def = state.registry[role];
  if (!def) throw new Error(`Unknown role: ${role}`);

  const cs = await getContainerState(def.containerName);
  if (cs.exists) {
    // Check for config drift — recreate if container has stale config
    const expected = buildExpectedConfig(role);
    const { hasDrift, drifts } = detectConfigDrift(cs, expected);
    if (hasDrift) {
      log.info(`Config drift detected for ${def.containerName}: ${drifts.join('; ')} — removing and recreating`);
      await removeContainer(def.containerName);
      // Fall through to pull + create below
    } else {
      return def.containerName;
    }
  } else {
    log.info(`Container ${def.containerName} not found — auto-provisioning for role ${role}...`);
  }

  // Pull image
  try {
    await pullImage(def.image);
  } catch (err) {
    log.error(`Failed to pull image ${def.image}: ${(err as Error).message}`);
    throw new Error(`Failed to pull image ${def.image}: ${(err as Error).message}`);
  }

  // Create container
  await createContainer(role);
  log.info(`Container ${def.containerName} created for role ${role}`);
  return def.containerName;
}

/**
 * Fire-and-forget: ensure the Ollama model is pulled inside the container.
 * Waits briefly for Ollama to initialize, checks if model exists, pulls if not.
 */
async function ensureOllamaModel(role: string): Promise<void> {
  const def = state.registry[role];
  if (!def || def.type !== 'ollama' || !def.model) return;

  // Skip if this model has failed too many times
  if ((state.pullFailCount[role] || 0) >= 3) {
    log.info(`ensureOllamaModel: skipping ${role} — pull failed 3+ times, not retrying until config change or restart`);
    return;
  }

  log.info(`ensureOllamaModel: starting for ${role} — model=${def.model} port=${def.port}`);
  try {
    // Wait for Ollama HTTP API to be ready (polls /api/tags, up to 30s)
    log.info(`ensureOllamaModel: waiting for Ollama API on port ${def.port}...`);
    await waitForOllama(def.port);
    log.info(`ensureOllamaModel: API ready, checking if ${def.model} is on disk...`);
    const diskModels = await ollamaList(def.port);
    const modelBase = def.model.split(':')[0];
    log.info(`ensureOllamaModel: models on disk: ${diskModels.join(', ')}`);
    let onDisk = diskModels.some(m => m === def.model || m.includes(modelBase));
    log.info(`ensureOllamaModel: looking for "${def.model}" (base="${modelBase}") in /api/tags → found=${onDisk}`);
    // Authoritative tiebreaker: /api/tags can return an empty list right after
    // container start (Ollama scans the manifest store lazily) so a "not found"
    // here often triggers a spurious 6 GB re-pull. /api/show is per-model and
    // returns 404 only when the model is genuinely absent.
    if (!onDisk) {
      try {
        const exists = await ollamaShow(def.port, def.model);
        if (exists) {
          log.info(`ensureOllamaModel: ${def.model} confirmed present via /api/show — skipping pull (was missing from /api/tags response, likely transient)`);
          onDisk = true;
        } else {
          log.info(`ensureOllamaModel: /api/show returned 404 for ${def.model} — model genuinely missing, will pull`);
        }
      } catch (showErr) {
        log.warn(`ensureOllamaModel: /api/show check failed: ${(showErr as Error).message} — falling back to pull`);
      }
    }
    if (onDisk) {
      log.info(`ensureOllamaModel: ${def.model} already present — skipping pull, loading into VRAM`);
      state.pullFailCount[role] = 0;
      fireAndForgetLoad(role, def.port, def.model);
      return;
    }

    // Pull model with task tracking via HTTP API
    const pullTaskId = tasks.start('model-pull', `Pull ${def.model}`, role);
    log.info(`ensureOllamaModel: STARTING PULL of ${def.model} on port ${def.port} (taskId=${pullTaskId})...`);
    try {
      const pullStart = Date.now();
      await ollamaPull(def.port, def.model, {
        onProgress: (pct, detail) => {
          log.info(`ensureOllamaModel: pull progress: ${pct}% ${detail.slice(0, 80)}`);
          tasks.update(pullTaskId, { progress: pct, detail: detail.slice(0, 80) });
        },
      });
      const pullDuration = Math.round((Date.now() - pullStart) / 1000);
      log.info(`ensureOllamaModel: pull finished in ${pullDuration}s`);

      // Post-pull verification: confirm model is now on disk
      log.info(`ensureOllamaModel: verifying ${def.model} is on disk after pull...`);
      const verifyModels = await ollamaList(def.port);
      log.info(`ensureOllamaModel: post-pull models: ${verifyModels.join(', ')}`);
      if (!verifyModels.some(m => m.includes(modelBase))) {
        tasks.fail(pullTaskId, 'Model not found on disk after pull');
        state.pullFailCount[role] = (state.pullFailCount[role] || 0) + 1;
        log.error(`ensureOllamaModel: ${def.model} not found on disk after pull (${state.pullFailCount[role]}x)`);
        if (state.pullFailCount[role] >= 3) {
          log.warn(`ensureOllamaModel: pull of ${def.model} failed 3 times, not retrying until config change or restart`);
        }
        return;
      }

      state.pullFailCount[role] = 0;
      tasks.complete(pullTaskId);
      log.info(`ensureOllamaModel: ${def.model} pulled and verified (${pullDuration}s)`);
    } catch (err) {
      state.pullFailCount[role] = (state.pullFailCount[role] || 0) + 1;
      log.error(`ensureOllamaModel: pull failed (${state.pullFailCount[role]}x): ${(err as Error).message}`);
      if (state.pullFailCount[role] >= 3) {
        log.warn(`ensureOllamaModel: pull of ${def.model} failed 3 times, not retrying until config change or restart`);
      }
      tasks.fail(pullTaskId, (err as Error).message);
      throw err;
    }

    fireAndForgetLoad(role, def.port, def.model);
  } catch (err) {
    log.error(`ensureOllamaModel: failed for ${def.model} on port ${def.port}: ${(err as Error).message}`);
  }
}

/** Fire-and-forget load a model into VRAM with duplicate-prevention guard and VRAM check. */
function fireAndForgetLoad(role: string, port: number, model: string, attempt = 1): void {
  if (state.modelLoading.has(role)) {
    log.info(`fireAndForgetLoad: ${role} already loading, skipping`);
    return;
  }

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY = 30_000; // 30s between retries

  // Check available VRAM before attempting load
  const def = state.registry[role];
  if (def && def.vram > 0 && state.gpuCache) {
    const freeVram = state.gpuCache.reduce((sum: number, g: any) => sum + (g.memoryFree || 0), 0);
    if (freeVram < def.vram * 0.5) {
      log.warn(`fireAndForgetLoad: ${role} needs ~${def.vram}MB VRAM but only ${freeVram}MB free — deferring load (attempt ${attempt}/${MAX_ATTEMPTS})`);
      if (attempt < MAX_ATTEMPTS) {
        setTimeout(() => fireAndForgetLoad(role, port, model, attempt + 1), RETRY_DELAY);
      } else {
        log.error(`fireAndForgetLoad: ${role} — gave up after ${MAX_ATTEMPTS} attempts, insufficient VRAM`);
      }
      return;
    }
  }

  log.info(`fireAndForgetLoad: loading ${model} for ${role} on port ${port} (attempt ${attempt}/${MAX_ATTEMPTS})${def?.gpuOnly ? ' [gpuOnly: evict + force GPU]' : ''}`);
  state.modelLoading.add(role);
  const loadTaskId = tasks.start('model-load', `Load ${model} into VRAM`, role);
  const loadPromise = def?.gpuOnly
    ? loadGpuOnly(role)
    : ollamaLoad(port, model, {
        onProgress: (detail) => {
          if (detail) {
            log.info(`fireAndForgetLoad: ${role} progress: "${detail.slice(0, 120)}"`);
            tasks.update(loadTaskId, { detail: detail.slice(0, 100) });
          }
        },
      });
  loadPromise.then((ok) => {
    if (ok) {
      tasks.complete(loadTaskId);
      log.info(`fireAndForgetLoad: ${role} loaded successfully`);
    } else {
      tasks.fail(loadTaskId, 'Load returned false');
      log.warn(`fireAndForgetLoad: ${role} load failed (attempt ${attempt}/${MAX_ATTEMPTS})`);
      // Retry after delay
      if (attempt < MAX_ATTEMPTS) {
        log.info(`fireAndForgetLoad: will retry ${role} in ${RETRY_DELAY / 1000}s`);
        setTimeout(() => fireAndForgetLoad(role, port, model, attempt + 1), RETRY_DELAY);
      } else {
        log.error(`fireAndForgetLoad: ${role} — all ${MAX_ATTEMPTS} load attempts failed`);
      }
    }
  }).catch((err) => {
    tasks.fail(loadTaskId, (err as Error).message);
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => fireAndForgetLoad(role, port, model, attempt + 1), RETRY_DELAY);
    }
  }).finally(() => {
    state.modelLoading.delete(role);
  });
}

function getTotalActiveRequests(): number {
  return Object.values(state.perRole).reduce((sum, r) => sum + r.activeRequests, 0) + state.activeRequests;
}

export { getTotalActiveRequests };

/**
 * Pull an Ollama model (force pull even if already present).
 * Optionally load into VRAM after pull completes.
 * Fire-and-forget — tracks progress via task system.
 */
export function pullOllamaModelAsync(role: string, andLoad: boolean): void {
  const def = state.registry[role];
  if (!def || def.type !== 'ollama' || !def.model) return;
  const model = def.model;

  const pullTaskId = tasks.start('model-pull', `Pull ${model}`, role);
  log.info(`pullOllamaModelAsync: pulling ${model} on port ${def.port} (andLoad=${andLoad})`);

  (async () => {
    await waitForOllama(def.port);
    const pullStart = Date.now();
    await ollamaPull(def.port, model, {
      onProgress: (pct, detail) => {
        log.info(`pullOllamaModelAsync: progress: ${pct}% ${detail.slice(0, 80)}`);
        tasks.update(pullTaskId, { progress: pct, detail: detail.slice(0, 80) });
      },
    });
    const pullDuration = Math.round((Date.now() - pullStart) / 1000);
    log.info(`pullOllamaModelAsync: pull finished in ${pullDuration}s`);
    tasks.complete(pullTaskId);
    log.info(`pullOllamaModelAsync: ${model} pulled successfully on port ${def.port}`);

    if (andLoad) {
      fireAndForgetLoad(role, def.port, model);
    }
  })().catch((err) => {
    tasks.fail(pullTaskId, (err as Error).message);
    log.error(`pullOllamaModelAsync: ${model} failed: ${(err as Error).message}`);
  });
}

/**
 * Recover from a Docker port conflict when starting a container.
 * Identifies what holds the port and attempts self-healing.
 */
async function recoverPortConflict(role: string, containerName: string, port: number): Promise<string> {
  log.info(`recoverPortConflict: port ${port} conflict for ${containerName} (role=${role})`);
  const holder = await findContainerOnPort(port);

  if (!holder) {
    throw new Error(`Port ${port} in use by external (non-Docker) process — cannot auto-recover`);
  }

  log.info(`recoverPortConflict: port ${port} held by container "${holder}"`);

  if (holder === containerName) {
    // Same container — check if it's actually running (stale Docker state)
    const cs = await getContainerState(containerName);
    if (cs.status === 'running') {
      log.info(`recoverPortConflict: ${containerName} is already running (stale state) — treating as success`);
      return 'already_running';
    }
    // Exited but port still bound — remove and recreate
    log.info(`recoverPortConflict: ${containerName} exited but port bound — removing and recreating`);
    await removeContainer(containerName);
    await createContainer(role);
    return await startContainer(containerName);
  }

  // Different container holds the port
  if (holder.startsWith('ss-')) {
    // It's one of our managed containers — stop and remove it, then retry
    log.info(`recoverPortConflict: stopping stale managed container "${holder}" to free port ${port}`);
    try { await stopContainer(holder); } catch { /* may already be stopped */ }
    await removeContainer(holder);
    return await startContainer(containerName);
  }

  // Non-managed container — we shouldn't touch it
  throw new Error(`Port ${port} in use by container "${holder}" (not managed by sidecar) — cannot auto-recover`);
}

export async function handleAcquire(role?: string): Promise<Record<string, unknown>> {
  if (role && state.registry[role]) {
    const def = state.registry[role];
    const r = state.perRole[role];

    // minOnline=0 is a hard "never auto-start" policy. Reject /acquire so the
    // master can't backdoor a load via resolveEndpoint() side-effects (e.g.
    // /api/ollama/models calling resolveEndpoint('completion') just to list).
    // The master's caller should fall back to the static-host path or surface
    // the error to the user.
    if ((state.minOnline?.[role] ?? 1) === 0) {
      log.info(`Acquire ${role} REJECTED — minOnline=0 (operator opted this role out)`);
      return { error: `Role "${role}" is disabled (minOnline=0). Set Minimum Online > 0 in admin to allow auto-start.` };
    }

    r.activeRequests++;
    clearIdleTimerForRole(role);
    r.lastAcquire = new Date().toISOString();
    recordDemandSample(role);
    log.info(`Acquire ${role} (active: ${r.activeRequests})`);

    const containerName = await ensureContainer(role);
    const cs = await getContainerState(containerName);
    if (cs.status === 'running') return { action: 'already_running', role, activeRequests: r.activeRequests };

    let result: string;
    try {
      result = await startContainer(containerName);
    } catch (err) {
      if (isPortConflict(err)) {
        result = await recoverPortConflict(role, containerName, def.port);
      } else {
        throw err;
      }
    }

    // Fire-and-forget: ensure Ollama model is pulled
    ensureOllamaModel(role).catch((err) => log.error(`ensureOllamaModel fire-and-forget failed for ${role}: ${(err as Error).message}`));
    return { action: result, role, activeRequests: r.activeRequests };
  }

  // Legacy: no role specified
  state.activeRequests++;
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  state.lastAcquire = new Date().toISOString();
  log.info(`Acquire legacy (active: ${state.activeRequests})`);

  const cs = await getContainerState();
  if (cs.status === 'running') return { action: 'already_running', activeRequests: state.activeRequests };
  if (!cs.exists || cs.status === 'not_found') return { error: `Container "${state.CONTAINER_NAME}" not found` };
  const result = await startContainer();
  return { action: result, activeRequests: state.activeRequests };
}

export async function handleRelease(role?: string): Promise<Record<string, unknown>> {
  if (role && state.perRole[role]) {
    const r = state.perRole[role];
    r.activeRequests = Math.max(0, r.activeRequests - 1);
    r.lastRelease = new Date().toISOString();
    log.info(`Release ${role} (active: ${r.activeRequests})`);
    if (r.activeRequests === 0) startIdleTimerForRole(role);
    return { role, activeRequests: r.activeRequests, idleTimerStarted: r.activeRequests === 0 };
  }

  // Legacy
  state.activeRequests = Math.max(0, state.activeRequests - 1);
  state.lastRelease = new Date().toISOString();
  log.info(`Release legacy (active: ${state.activeRequests})`);
  if (state.activeRequests === 0) startIdleTimer(role);
  return { activeRequests: state.activeRequests, idleTimerStarted: state.activeRequests === 0 };
}

export async function handleStart(role?: string): Promise<Record<string, unknown>> {
  if (role) clearIdleTimerForRole(role);
  else clearAllIdleTimers();

  // Auto-provision if role is known and container doesn't exist
  let containerName: string;
  if (role && state.registry[role]) {
    containerName = await ensureContainer(role);
  } else {
    containerName = state.CONTAINER_NAME;
  }

  log.info(`Manual start requested: ${containerName}`);

  const cs = await getContainerState(containerName);
  if (cs.status === 'running') return { status: 'running', message: `${containerName} is already running` };
  if (!cs.exists || cs.status === 'not_found') return { error: `Container "${containerName}" not found` };
  await startContainer(containerName);
  // Fire-and-forget: ensure Ollama model is pulled
  if (role) ensureOllamaModel(role).catch((err) => log.error(`ensureOllamaModel fire-and-forget failed for ${role}: ${(err as Error).message}`));
  return { status: 'running', message: `${containerName} started` };
}

export async function handleStop(role?: string): Promise<Record<string, unknown>> {
  const containerName = role && state.registry[role] ? state.registry[role].containerName : state.CONTAINER_NAME;
  if (role) clearIdleTimerForRole(role);
  else clearAllIdleTimers();
  log.info(`Manual stop requested: ${containerName}`);

  const cs = await getContainerState(containerName);
  if (cs.status === 'exited' || !cs.exists || cs.status === 'not_found') {
    return { status: 'exited', message: `${containerName} is already stopped` };
  }
  await stopContainer(containerName);
  return { status: 'exited', message: `${containerName} stopped. GPU VRAM freed.` };
}

export async function handleStatus(): Promise<Record<string, unknown>> {
  const containers = await getAllContainerStates();

  const roles: Record<string, unknown> = {};
  for (const [role, r] of Object.entries(state.perRole)) {
    roles[role] = {
      activeRequests: r.activeRequests,
      idleTimerActive: r.idleTimer !== null,
      lastAcquire: r.lastAcquire,
      lastRelease: r.lastRelease,
    };
  }

  // VRAM accounting — best-effort. If nvidia-smi or any endpoint hiccups, we
  // still return the rest of the status with vram=null so the UI can render.
  let vram: unknown = null;
  try {
    const { snapshotVram } = await import('./vram-accountant');
    vram = await snapshotVram();
  } catch (err) {
    log.warn(`handleStatus: vram snapshot failed: ${(err as Error).message}`);
  }

  return {
    hostname: os.hostname(),
    ip: getPrimaryIp(),
    agent: { uptime: Math.floor((Date.now() - state.startedAt) / 1000), version: sidecarVersion },
    container: containers.reranker || await getContainerState(),
    containers,
    mode: state.currentMode,
    activeRequests: getTotalActiveRequests(),
    idleTimerActive: Object.values(state.perRole).some((r) => r.idleTimer !== null) || state.idleTimer !== null,
    idleTimeouts: state.idleTimeouts,
    minOnline: state.minOnline,
    lastConfigPushAt: state.lastConfigPushAt ?? null,
    roles,
    peakDemand: getPeakDemand(),
    containerName: state.CONTAINER_NAME,
    lastAcquire: state.lastAcquire,
    lastRelease: state.lastRelease,
    // Multi-master: wsConnected is "any master on WS"; preserved as boolean for legacy UI.
    wsConnected: (() => {
      for (const m of state.masters.values()) {
        if (m.connectionMode === 'websocket' && m.ws !== null && (m.ws as { readyState: number }).readyState === 1) return true;
      }
      return false;
    })(),
    wsCommandCount: state.wsCommandCount,
    serverUrl: state.serverUrl, // legacy single-URL — first master
    masters: [...state.masters.values()].map(m => ({
      serverUrl: m.serverUrl,
      wsPort: m.wsPort ?? null,
      connectionMode: m.connectionMode,
      lastHeartbeatAt: m.lastHeartbeatAt ?? null,
      lastSeenServerVersion: m.lastSeenServerVersion ?? null,
      pendingCommandCount: m.pendingCommands.size,
    })),
    savedAgentUrl: state.savedAgentUrl,
    dockerMode: getDockerMode(),
    tasks: tasks.getAll(),
    connectionStatus: state.connectionStatus,
    vram,
  };
}
