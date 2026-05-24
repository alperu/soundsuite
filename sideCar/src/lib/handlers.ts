import { state, HOST_STATS_TTL_MS, ensureSet } from './state';
import { getContainerState, startContainer, stopContainer, removeContainer, createContainer, pullImage, getDockerMode, isDockerAvailable, buildExpectedConfig, detectConfigDrift, isPortConflict, findContainerOnPort, dockerRequest } from './docker';
import { ollamaList, ollamaShow, ollamaPull, ollamaLoad, ollamaUnload, waitForOllama } from './ollama-api';
import { loadGpuOnly, ensureContainerForRole } from './containers';
import { clearIdleTimerForRole, clearAllIdleTimers, startIdleTimerForRole, startIdleTimer } from './idle-timers';
import { getAllContainerStates } from './containers';
import { createLogger } from './logger';
import { recordDemandSample, getPeakDemand } from './demand-tracker';
import { tasks } from './task-tracker';
import { getBootEvents, getBootEpoch } from './boot-events';
import fs from 'fs';
import path from 'path';
import os from 'os';

const log = createLogger('handlers');

/**
 * Pre-flight check: refuse to attempt docker operations when the sidecar
 * has no working Docker connection. Returns a descriptive error string the
 * caller can surface to the master/UI, or null when Docker is reachable.
 *
 * Without this guard a docker-runtime start would bubble up "connect ENOENT
 * /var/run/docker.sock" or similar, which the master forwards as an opaque
 * 502 to the dashboard. Operators on BASWS34 saw this when the sidecar
 * container was run without `-v /var/run/docker.sock:/var/run/docker.sock`.
 */
function preflightDockerError(role: string | undefined): string | null {
  // Don't trust getDockerMode() alone — it caches whatever initDocker()
  // resolved at sidecar startup. If the daemon was momentarily unreachable
  // during boot but the socket exists / Docker recovered, dockerMode stays
  // 'none' even though subsequent operations (image pulls via the default
  // socket fallback in dockerConnectionOpts) succeed. Use isDockerAvailable()
  // which also checks the socket file as a fallback signal.
  if (!isDockerAvailable()) {
    return (
      `Sidecar lacks /var/run/docker.sock mount — host Docker is unreachable` +
      (role ? ` (role: ${role})` : '') + `. ` +
      `Recreate the sidecar container with: ` +
      `docker run ... -v /var/run/docker.sock:/var/run/docker.sock soundsuite-sidecar:<version>`
    );
  }
  // Avoid TS6133 since we kept the import for diagnostics callers elsewhere.
  void getDockerMode;
  return null;
}

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

  // Honor operator's minOnline=0 opt-out. The acquire path already rejects;
  // belt-and-suspenders here so heartbeat / container-create callers can't
  // sneak a pull+load past the policy.
  if ((state.minOnline?.[role] ?? 1) === 0) {
    log.info(`ensureOllamaModel: skipping ${role} — minOnline=0 (operator opted this role out)`);
    return;
  }

  // Skip if this model has failed too many times
  if ((state.pullFailCount[role] || 0) >= 3) {
    log.info(`ensureOllamaModel: skipping ${role} — pull failed 3+ times, not retrying until config change or restart`);
    return;
  }

  log.info(`ensureOllamaModel: starting for ${role} — model=${def.model} port=${def.port}${def.runtime === 'host' ? ' [host-runtime]' : ''}`);
  try {
    // Wait for Ollama HTTP API to be ready (polls /api/tags, up to 30s)
    log.info(`ensureOllamaModel: waiting for Ollama API on port ${def.port}...`);
    await waitForOllama(def.port, 30_000, role);
    log.info(`ensureOllamaModel: API ready, checking if ${def.model} is on disk...`);
    const diskModels = await ollamaList(def.port, role);
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
        const exists = await ollamaShow(def.port, def.model, role);
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
        role,
      });
      const pullDuration = Math.round((Date.now() - pullStart) / 1000);
      log.info(`ensureOllamaModel: pull finished in ${pullDuration}s`);

      // Post-pull verification: confirm model is now on disk
      log.info(`ensureOllamaModel: verifying ${def.model} is on disk after pull...`);
      const verifyModels = await ollamaList(def.port, role);
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
  if (ensureSet('modelLoading').has(role)) {
    log.info(`fireAndForgetLoad: ${role} already loading, skipping`);
    return;
  }

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY = 30_000; // 30s between retries

  // Check available VRAM before attempting load. Skip for host-runtime roles:
  // state.gpuCache is from nvidia-smi inside the sidecar container, which is
  // empty on Mac/Windows hosts. Ollama on the host manages its own VRAM and
  // will simply return a load error if there's no room.
  const def = state.registry[role];
  if (def && def.runtime !== 'host' && def.vram > 0 && state.gpuCache) {
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

  log.info(`fireAndForgetLoad: loading ${model} for ${role} on port ${port} (attempt ${attempt}/${MAX_ATTEMPTS})${def?.gpuOnly ? ' [gpuOnly: evict + force GPU]' : ''}${def?.runtime === 'host' ? ' [host-runtime]' : ''}`);
  ensureSet('modelLoading').add(role);
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
        role,
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
    ensureSet('modelLoading').delete(role);
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
  // Honor operator opt-out — applies to background pulls as well as acquire.
  if ((state.minOnline?.[role] ?? 1) === 0) {
    log.info(`pullOllamaModelAsync: skipping ${role} — minOnline=0 (operator opted this role out)`);
    return;
  }
  const model = def.model;

  const pullTaskId = tasks.start('model-pull', `Pull ${model}`, role);
  log.info(`pullOllamaModelAsync: pulling ${model} on port ${def.port} (andLoad=${andLoad})`);

  (async () => {
    await waitForOllama(def.port, 30_000, role);
    const pullStart = Date.now();
    await ollamaPull(def.port, model, {
      onProgress: (pct, detail) => {
        log.info(`pullOllamaModelAsync: progress: ${pct}% ${detail.slice(0, 80)}`);
        tasks.update(pullTaskId, { progress: pct, detail: detail.slice(0, 80) });
      },
      role,
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
 * Manual "Pull" (and optional Load) for a role.
 *
 * Runtime-aware dispatch:
 *   - host           → Ollama HTTP API on the host's native Ollama
 *                      (ollamaPull then optionally ollamaLoad). No Docker.
 *   - docker-ollama  → ensureContainer (pull image + create + start) then
 *                      ollamaPull/ollamaLoad against the container's port.
 *   - docker-vllm    → pullImage + ensureContainer + startContainer. vLLM
 *                      lazy-downloads the HuggingFace model on first request.
 *   - docker-model-runner → no-op; DMR has no pull API. Operator must run
 *                      `docker model pull <model>` on the host.
 *
 * Returns a plain { ok / error / message } payload suitable for both the
 * HTTP `/api/containers` route and the WS dispatcher.
 */
export async function handlePullModel(role: string, andLoad: boolean): Promise<Record<string, unknown>> {
  const def = state.registry[role];
  if (!def) return { error: `Unknown role: ${role}` };

  // Honor operator opt-out — same policy as acquire/start.
  if ((state.minOnline?.[role] ?? 1) === 0) {
    log.info(`Pull ${role}: REJECTED — minOnline=0 (operator opted this role out)`);
    return { error: `Role "${role}" is disabled (minOnline=0). Set Minimum Online > 0 in admin to allow pull.` };
  }

  // Manual Pull clears user-stopped intent — the operator is asking us to
  // load this role's model, so the heartbeat may re-engage afterwards.
  ensureSet('userStopped').delete(role);

  if (def.runtime === 'docker-model-runner') {
    log.info(`Pull ${role}: runtime=docker-model-runner -> no-op (operator must run "docker model pull ${def.model}" on host)`);
    return {
      ok: true,
      message: `${role} on Docker Model Runner — pull is host-side. Run "docker model pull ${def.model}" on ${state.dmrHost} to fetch the model.`,
    };
  }

  if (def.type === 'vllm') {
    // docker-vllm path. pull image + ensure container + start so vLLM
    // begins downloading the HF model.
    if (!def.image) return { error: `${role}: no docker image configured` };
    log.info(`Pull ${role}: runtime=docker-vllm -> pullImage ${def.image} + start container ${def.containerName}`);
    try {
      await pullImage(def.image);
    } catch (err) {
      return { error: `Image pull failed: ${(err as Error).message}` };
    }
    await ensureContainerForRole(role);
    const csv = await getContainerState(def.containerName);
    if (csv.status !== 'running') {
      await startContainer(def.containerName);
    }
    return {
      ok: true,
      model: def.model,
      container: def.containerName,
      message: `${def.model} image pulled and container started — vLLM downloads the HF model on first request (cached afterwards)`,
    };
  }

  if (def.type !== 'ollama' || !def.model) {
    return { error: `${role}: not an Ollama role with a model` };
  }

  // Both host-ollama and docker-ollama use the same Ollama HTTP API path.
  // pullOllamaModelAsync is fire-and-forget — progress reported via task system.
  // For host: ollamaPull/Load address state.hostOllamaHost:HOST_OLLAMA_PORT
  // via getDockerHost(role). For docker: addresses the container by its port.
  if (def.runtime === 'host') {
    log.info(`Pull ${role}: runtime=host -> ollamaPull ${def.model} on ${state.hostOllamaHost}:${def.port}${andLoad ? ' (and load)' : ''}`);
    pullOllamaModelAsync(role, andLoad);
    return {
      ok: true,
      model: def.model,
      message: `Pull${andLoad ? ' + load' : ''} started for ${def.model} on host Ollama (${state.hostOllamaHost}:${def.port})`,
    };
  }

  // docker-ollama: ensure the container is up before talking to its
  // /api/pull. pullOllamaModelAsync handles the rest.
  log.info(`Pull ${role}: runtime=docker-ollama -> ensureContainer ${def.containerName} + ollamaPull ${def.model}${andLoad ? ' (and load)' : ''}`);
  try {
    await ensureContainer(role);
    const cs = await getContainerState(def.containerName);
    if (cs.status !== 'running') {
      await startContainer(def.containerName);
    }
  } catch (err) {
    return { error: `Failed to prepare ${def.containerName}: ${(err as Error).message}` };
  }
  pullOllamaModelAsync(role, andLoad);
  return {
    ok: true,
    model: def.model,
    container: def.containerName,
    message: `Pull${andLoad ? ' + load' : ''} started for ${def.model}`,
  };
}

/**
 * Manual "Load" for a role — load the configured model into VRAM (or start
 * the vLLM container, which loads the model at startup).
 *
 * Runtime-aware dispatch:
 *   - host           → ollamaLoad against the host's native Ollama.
 *   - docker-ollama  → ensureContainer + ollamaLoad against the container.
 *                      gpuOnly roles use loadGpuOnly() (evicts competitors
 *                      and forces num_gpu).
 *   - docker-vllm    → start the vLLM container; vLLM loads on startup.
 *   - docker-model-runner → no-op; DMR lazy-loads on first inference.
 */
export async function handleLoadModel(role: string): Promise<Record<string, unknown>> {
  const def = state.registry[role];
  if (!def) return { error: `Unknown role: ${role}` };
  if (!def.model) return { error: `No model configured for ${role}` };

  if ((state.minOnline?.[role] ?? 1) === 0) {
    log.info(`Load ${role}: REJECTED — minOnline=0 (operator opted this role out)`);
    return { error: `Role "${role}" is disabled (minOnline=0). Set Minimum Online > 0 in admin to allow loading.` };
  }

  // Manual Load clears user-stopped intent.
  ensureSet('userStopped').delete(role);

  if (def.runtime === 'docker-model-runner') {
    log.info(`Load ${role}: runtime=docker-model-runner -> no-op (DMR lazy-loads on first inference)`);
    return {
      ok: true,
      model: def.model,
      message: `${role} on Docker Model Runner — no explicit load API; DMR lazy-starts ${def.model} on first inference request.`,
    };
  }

  if (def.type === 'vllm') {
    log.info(`Load ${role}: runtime=docker-vllm -> start container ${def.containerName} (vLLM loads model at startup)`);
    const csv = await getContainerState(def.containerName);
    if (csv.status !== 'running') {
      try {
        await ensureContainerForRole(role);
        await startContainer(def.containerName);
      } catch (err) {
        return { error: `Failed to start ${def.containerName}: ${(err as Error).message}` };
      }
      return {
        ok: true,
        model: def.model,
        container: def.containerName,
        message: `${def.containerName} started — vLLM is loading ${def.model}`,
      };
    }
    return {
      ok: true,
      model: def.model,
      container: def.containerName,
      message: `${def.containerName} already running`,
    };
  }

  if (def.type !== 'ollama') {
    return { error: `${role}: not an Ollama or vLLM role` };
  }

  if (def.runtime === 'host') {
    log.info(`Load ${role}: runtime=host -> ollamaLoad ${def.model} on ${state.hostOllamaHost}:${def.port}`);
    const loaded = def.gpuOnly
      ? await loadGpuOnly(role)
      : await ollamaLoad(def.port, def.model, { role });
    if (!loaded) {
      const reason = def.gpuOnly
        ? `Failed to load ${def.model} fully on GPU on host Ollama (insufficient VRAM after eviction)`
        : `Failed to load ${def.model} on host Ollama (${state.hostOllamaHost}:${def.port})`;
      return { error: reason };
    }
    return {
      ok: true,
      model: def.model,
      message: `${def.model} loaded into VRAM on host Ollama${def.gpuOnly ? ' (full GPU)' : ''}`,
    };
  }

  // docker-ollama: ensure the container is running before /api/generate.
  log.info(`Load ${role}: runtime=docker-ollama -> ensureContainer ${def.containerName} + ollamaLoad ${def.model}`);
  try {
    await ensureContainer(role);
    const cs = await getContainerState(def.containerName);
    if (cs.status !== 'running') {
      await startContainer(def.containerName);
    }
  } catch (err) {
    return { error: `Failed to prepare ${def.containerName}: ${(err as Error).message}` };
  }
  const loaded = def.gpuOnly
    ? await loadGpuOnly(role)
    : await ollamaLoad(def.port, def.model, { role });
  if (!loaded) {
    const reason = def.gpuOnly
      ? `Failed to load ${def.model} fully on GPU (insufficient VRAM after eviction)`
      : `Failed to load ${def.model} into VRAM`;
    return { error: reason };
  }
  return {
    ok: true,
    model: def.model,
    container: def.containerName,
    message: `${def.model} loaded into VRAM${def.gpuOnly ? ' (full GPU)' : ''}`,
  };
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
    // Manual Acquire clears any prior user-stopped intent — the operator
    // is asking us to use this role again, so the heartbeat may re-engage.
    ensureSet('userStopped').delete(role);
    r.lastAcquire = new Date().toISOString();
    recordDemandSample(role);
    log.info(`Acquire ${role} (active: ${r.activeRequests})${def.runtime === 'host' ? ' [host-runtime]' : def.runtime === 'docker-model-runner' ? ' [dmr]' : ''}`);

    // Host-runtime: no container to start. ensureContainerForRole() probes
    // native Ollama reachability — the local docker-only ensureContainer()
    // would call pullImage(def.image='') and throw with
    // "Failed to pull image : Pull  failed (500): no Host in request URL".
    // See containers.ts:ensureContainerForRole for the runtime-aware branch.
    if (def.runtime === 'host') {
      try {
        await ensureContainerForRole(role); // probes host Ollama; throws if unreachable
      } catch (err) {
        r.activeRequests = Math.max(0, r.activeRequests - 1);
        return { error: (err as Error).message };
      }
      ensureOllamaModel(role).catch((err) => log.error(`ensureOllamaModel fire-and-forget failed for ${role}: ${(err as Error).message}`));
      return { action: 'host-runtime', role, activeRequests: r.activeRequests };
    }

    // Docker Model Runner: probe DMR's TCP endpoint. No image, no model
    // pull (DMR has no auto-pull API). Master talks directly to
    // dmrHost:dmrPort/engines/v1 for inference.
    if (def.runtime === 'docker-model-runner') {
      try {
        await ensureContainer(role);
      } catch (err) {
        r.activeRequests = Math.max(0, r.activeRequests - 1);
        return { error: (err as Error).message };
      }
      return { action: 'docker-model-runner', role, activeRequests: r.activeRequests };
    }

    // Same docker-socket preflight as handleStart — return a clear error
    // instead of a deep connect-ENOENT trace when the sidecar wasn't run
    // with -v /var/run/docker.sock:/var/run/docker.sock.
    {
      const pf = preflightDockerError(role);
      if (pf) {
        r.activeRequests = Math.max(0, r.activeRequests - 1);
        log.error(`handleAcquire preflight: ${pf}`);
        return { error: pf };
      }
    }

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

/**
 * Heartbeat: re-arm the idle timer for a role without bumping activeRequests.
 * Master calls this every ~60s while it considers the role "actively needed".
 * Without it, the sidecar's idle timer fires after `idleTimeouts[role]` of
 * silence and either stops the container (when minOnline=0) or no-ops (when
 * minOnline>=1, per the guard in idle-timers.ts). Touch is the explicit
 * "still interested" signal — cheaper than /acquire+/release and safe to
 * call repeatedly.
 */
export async function handleTouch(role?: string): Promise<Record<string, unknown>> {
  const r = role || 'reranker';
  if (!state.perRole[r]) {
    return { ok: false, role: r, error: `unknown role` };
  }
  startIdleTimerForRole(r);
  state.perRole[r].lastRelease = new Date().toISOString();
  return {
    ok: true,
    role: r,
    activeRequests: state.perRole[r].activeRequests,
    idleTimerArmed: true,
  };
}

/**
 * Reset leaked activeRequests counters.
 * Used to recover from master-side bugs that send more /acquire than /release
 * (the historic failure mode that pinned VRAM at 99% — see
 * src/lib/search/reranker.ts pre-fix). Zeroes the counter for the given role
 * (or every role if none specified) and starts the idle timer when the role
 * is otherwise idle so the container can stop on its own schedule.
 */
export async function handleResetCounters(role?: string): Promise<Record<string, unknown>> {
  const targets = role ? [role] : Object.keys(state.perRole);
  const reset: Record<string, { previous: number; idleTimerStarted: boolean }> = {};

  for (const r of targets) {
    const perRole = state.perRole[r];
    if (!perRole) {
      reset[r] = { previous: 0, idleTimerStarted: false };
      continue;
    }
    const previous = perRole.activeRequests;
    perRole.activeRequests = 0;
    perRole.lastRelease = new Date().toISOString();
    let idleTimerStarted = false;
    if (previous > 0) {
      startIdleTimerForRole(r);
      idleTimerStarted = true;
      log.warn(`Reset ${r} counter: ${previous} -> 0 (idle timer started)`);
    } else {
      log.info(`Reset ${r} counter: already 0 (no-op)`);
    }
    reset[r] = { previous, idleTimerStarted };
  }

  // Legacy single-counter — only zero when no role filter was given
  let legacy: { previous: number; idleTimerStarted: boolean } | undefined;
  if (!role) {
    const previous = state.activeRequests;
    state.activeRequests = 0;
    state.lastRelease = new Date().toISOString();
    let idleTimerStarted = false;
    if (previous > 0) {
      startIdleTimer();
      idleTimerStarted = true;
      log.warn(`Reset legacy counter: ${previous} -> 0`);
    }
    legacy = { previous, idleTimerStarted };
  }

  return { reset, legacy };
}

export async function handleStart(role?: string): Promise<Record<string, unknown>> {
  // Honor operator opt-out. handleStart can be called from the master's WS
  // "start" command, from setup-overrides reapply, and from autoProvision
  // fall-through. Without this guard, a minOnline=0 role can still start its
  // container / load its model — the exact bug that left qwen3.5:9b loaded.
  if (role && (state.minOnline?.[role] ?? 1) === 0) {
    log.info(`handleStart ${role} REJECTED — minOnline=0 (operator opted this role out)`);
    return { error: `Role "${role}" is disabled (minOnline=0). Set Minimum Online > 0 in admin to allow start.` };
  }
  if (role) {
    clearIdleTimerForRole(role);
    // Manual Start clears the user-stopped intent — symmetric with Acquire.
    ensureSet('userStopped').delete(role);
  } else {
    clearAllIdleTimers();
  }

  // Host-runtime: "start" means probe + load model. No Docker.
  // IMPORTANT: route through ensureContainerForRole (containers.ts), not the
  // local docker-only ensureContainer. The local helper blindly calls
  // pullImage(def.image) + createContainer, which on host-runtime roles
  // means pullImage('') (def.image is empty) and a guaranteed throw —
  // exactly the bug that produced "HTTP 404 / 500" on win32 hosts before
  // the master started shipping docker-runtime registry entries for
  // WSL2+NVIDIA. ensureContainerForRole knows about runtimes and probes
  // native Ollama instead.
  if (role && state.registry[role]?.runtime === 'host') {
    const def = state.registry[role];
    try {
      await ensureContainerForRole(role);
    } catch (err) {
      return { error: (err as Error).message };
    }
    ensureOllamaModel(role).catch((err) => log.error(`ensureOllamaModel fire-and-forget failed for ${role}: ${(err as Error).message}`));
    return { status: 'running', message: `host Ollama for ${role} ready (${state.hostOllamaHost}:${def.port})` };
  }

  // Docker Model Runner: probe only. No model load — DMR lazy-starts on
  // first inference request. Same reasoning as host-runtime above: the
  // local ensureContainer cannot handle non-docker runtimes.
  if (role && state.registry[role]?.runtime === 'docker-model-runner') {
    try {
      await ensureContainerForRole(role);
    } catch (err) {
      return { error: (err as Error).message };
    }
    return { status: 'running', message: `Docker Model Runner ready for ${role} at ${state.dmrHost}:${state.dmrPort}` };
  }

  // Docker-runtime roles need a reachable Docker daemon. Fail fast with a
  // descriptive message when the socket isn't mounted, instead of letting
  // ensureContainer surface a low-level connect-ENOENT through the master
  // as a generic 502/500.
  {
    const pf = preflightDockerError(role);
    if (pf) {
      log.error(`handleStart preflight: ${pf}`);
      return { error: pf };
    }
  }

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
  // Docker Model Runner: no unload API. Clear idle timer and return —
  // DMR's scheduler reaps idle workers on its own. Deferred to v2 when
  // DMR exposes an unload endpoint.
  if (role && state.registry[role]?.runtime === 'docker-model-runner') {
    clearIdleTimerForRole(role);
    ensureSet('userStopped').add(role);
    log.info(`Stop ${role}: runtime=docker-model-runner -> no unload API (DMR manages eviction); idle timer cleared`);
    return { status: 'exited', message: `${role} on DMR — no unload API; idle timer cleared (DMR manages its own lifecycle)` };
  }

  // Host-runtime: "stop" means evict the model from host Ollama VRAM via
  // keep_alive: 0. The Ollama process itself keeps running. We also mark
  // the role as user-stopped so the heartbeat auto-loader doesn't reload
  // it within 60 s; cleared on the next Acquire/Start for the role.
  if (role && state.registry[role]?.runtime === 'host') {
    const def = state.registry[role];
    clearIdleTimerForRole(role);
    ensureSet('userStopped').add(role);
    if (!def.model) {
      log.info(`Stop ${role}: runtime=host -> no model configured, idle timer cleared`);
      return { status: 'exited', message: `${role}: no model configured to unload` };
    }
    log.info(`Stop ${role}: runtime=host -> ollamaUnload ${def.model} (host=${state.hostOllamaHost}:${def.port})`);
    const ok = await ollamaUnload(def.port, def.model, role);
    return ok
      ? { status: 'exited', message: `host Ollama unloaded ${def.model} for ${role} — VRAM freed (auto-load suppressed until next Acquire)` }
      : { error: `Failed to unload ${def.model} on host Ollama (best-effort)` };
  }

  const containerName = role && state.registry[role] ? state.registry[role].containerName : state.CONTAINER_NAME;
  if (role) {
    clearIdleTimerForRole(role);
    // Same user-stopped intent for Docker-runtime roles. Even though the
    // container being `exited` already gates the heartbeat, recording the
    // intent makes the policy uniform across runtimes.
    ensureSet('userStopped').add(role);
  } else {
    clearAllIdleTimers();
  }
  log.info(`Stop ${role || 'legacy'}: runtime=docker -> dockerStop ${containerName}`);

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

  // Host-Ollama block — only meaningful when SS_HOST_OLLAMA=1. Surfaces the
  // last health probe so admin UI can render an actionable error (install
  // Ollama vs check Docker networking vs start the service).
  const hostOllama = {
    enabled: state.hostOllamaEnabled,
    host: state.hostOllamaHost,
    roles: Array.from(state.hostOllamaRoles),
    budgetMb: state.hostOllamaBudgetMb,
    lastHealth: state.hostOllamaLastHealth,
  };

  // DMR (Docker Model Runner) block — surfaced for master visibility.
  // baseUrl is the URL the master should use for direct inference calls
  // (master never proxies inference through the sidecar).
  const dmr = {
    enabled: state.dmrEnabled,
    host: state.dmrHost,
    port: state.dmrPort,
    roles: Array.from(state.dmrRoles),
    budgetMb: state.dmrBudgetMb,
    lastHealth: state.dmrLastHealth,
    baseUrl: state.dmrEnabled ? `http://${state.dmrHost}:${state.dmrPort}/engines/v1` : null,
  };

  // Tier 1: "Sound Suite inference memory" — what's currently loaded on host
  // Ollama and how much of the operator's budget is left. Pure in-container,
  // works without any host-side helper.
  let inferenceMemory: unknown = null;
  try {
    const { snapshotInferenceMemory } = await import('./vram-accountant');
    inferenceMemory = await snapshotInferenceMemory();
  } catch (err) {
    log.warn(`handleStatus: inferenceMemory snapshot failed: ${(err as Error).message}`);
  }

  // Tier 2 (with fallback): host-wide stats. Prefer fresh helper data; fall
  // back to docker /info.MemTotal (the VM's RAM, not the true host's) when
  // the helper is absent or stale. The UI uses `source` to label accordingly.
  const now = Date.now();
  let hostStatsOut: Record<string, unknown> | null = null;
  if (state.hostStats && now - state.hostStats.at <= HOST_STATS_TTL_MS) {
    const s = state.hostStats;
    // Normalize: helper-provided MB fields and structured byte fields can
    // both be present. Pick the most informative.
    const totalMb =
      s.memory?.totalBytes !== undefined
        ? Math.round(s.memory.totalBytes / (1024 * 1024))
        : s.totalMb ?? 0;
    const freeMb =
      s.memory?.freeBytes !== undefined
        ? Math.round(s.memory.freeBytes / (1024 * 1024))
        : s.freeMb ?? 0;
    const pressurePct = s.mac?.memoryPressurePct ?? s.pressurePct ?? 0;
    hostStatsOut = {
      at: s.at,
      ageMs: Math.max(0, now - s.at),
      totalMb,
      freeMb,
      pressurePct,
      gpuName: s.mac?.gpuName ?? s.gpuName ?? null,
      gpuUtilPct: s.mac?.gpuUtilPct ?? s.gpuUtilPct ?? null,
      source: 'helper' as const,
      stale: false,
    };
  } else {
    // Fallback: probe Docker /info for VM memory total. Not the host's RAM,
    // but at least non-null on Mac/Windows so the UI can render a label.
    let dockerVmTotalMb = 0;
    try {
      const { status, body } = await dockerRequest('GET', '/info');
      if (status === 200) {
        const info = JSON.parse(body) as { MemTotal?: number };
        if (typeof info.MemTotal === 'number') {
          dockerVmTotalMb = Math.round(info.MemTotal / (1024 * 1024));
        }
      }
    } catch (err) {
      log.info(`handleStatus: docker /info probe failed: ${(err as Error).message}`);
    }
    // For "free", subtract whatever Sound Suite currently has loaded. Not
    // accurate (other host processes consume RAM too) but better than nothing.
    const inferenceUsed =
      inferenceMemory && typeof inferenceMemory === 'object'
        ? (inferenceMemory as { usedMb?: number }).usedMb ?? 0
        : 0;
    hostStatsOut = {
      at: state.hostStats?.at ?? null,
      ageMs: state.hostStats ? now - state.hostStats.at : null,
      totalMb: dockerVmTotalMb,
      freeMb: Math.max(0, dockerVmTotalMb - inferenceUsed),
      pressurePct: 0,
      gpuName: null,
      gpuUtilPct: null,
      source: dockerVmTotalMb > 0 ? ('docker-info' as const) : ('unknown' as const),
      // True iff we had data once but it has since aged out.
      stale: state.hostStats !== null,
    };
  }

  // Host OS detection for admin-UI affordances (correct install instructions).
  // `hasNvidia` is sticky — once a helper has reported an NVIDIA card we
  // surface it even if the latest stats are stale, so /admin/gpu can render
  // "helper-script disconnected" instead of "no GPU".
  const host = {
    os: state.hostOs,
    osConfidence: state.hostOsConfidence,
    dockerDesktop: state.hostOsDockerDesktop,
    hasNvidia: state.hasNvidiaSmi,
    stats: hostStatsOut,
    inferenceMemory,
    // Pass through the most recent GPU list reported by the host helper.
    // Mirrors top-level `gpus` below; included on `host` so /admin/gpu
    // can render even without joining two payload sections.
    gpus: state.hostStats?.gpus ?? state.gpuCache ?? [],
  };

  // Top-level GPU list — same data /api/gpu returns. Master's GPU page
  // reads this so both endpoints agree.
  const gpus = state.hostStats?.gpus ?? state.gpuCache ?? [];

  return {
    hostname: os.hostname(),
    ip: getPrimaryIp(),
    agent: { uptime: Math.floor((Date.now() - state.startedAt) / 1000), version: sidecarVersion },
    container: containers.reranker || await getContainerState(),
    containers,
    hostOllama,
    dmr,
    host,
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
    gpus,
    // Boot event ring buffer — emitted ONCE per boot per event. Consumers
    // dedupe by `seq` (monotonic) and render `ts` / `message` on the
    // Activity Log. Capped at 100 entries; never grows after boot finishes.
    bootLog: getBootEvents(),
    // Stable per-process boot epoch (ms). UI/master detect sidecar restarts by
    // observing a change in this value and reset their seenBootSeq high-water-mark
    // so the fresh boot trace renders instead of being filtered as "already seen".
    bootEpoch: getBootEpoch(),
    // Orphan containers: ss-* docker containers not in current registry.
    // The orphan sweep on every /config push stops running ones; this lets
    // the master surface their existence so operator can re-assign the role
    // or `docker rm` for disk reclaim.
    orphanContainers: await (async () => {
      try {
        const { listOrphanContainers } = await import('./containers');
        return await listOrphanContainers();
      } catch {
        return [];
      }
    })(),
  };
}
