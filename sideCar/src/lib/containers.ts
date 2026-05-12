import { state, dockerSupportsGpu, CONTAINER_PREFIX, type ContainerDef } from './state';
import { getContainerState, startContainer, stopContainer, removeContainer, pullImage, createContainer, dockerRequest, buildExpectedConfig, detectConfigDrift, listContainersByPrefix, type ContainerState } from './docker';
import { ollamaPs, ollamaList, ollamaPsCached, ollamaListCached, ollamaPull, ollamaLoad, ollamaUnload, waitForOllama, ollamaIsReady } from './ollama-api';
import { dmrIsReady, dmrListModels } from './dmr-api';
import { snapshotVram } from './vram-accountant';
import { planEviction, type EvictionStep } from './eviction-planner';
import { clearIdleTimerForRole } from './idle-timers';
import { saveConfig } from './config';
import { createLogger } from './logger';
import { tasks } from './task-tracker';

/**
 * Build a synthetic ContainerState for a host-runtime role. The sidecar
 * doesn't manage a Docker container for these — Ollama runs natively on
 * the Docker host. Initially synthesized with `status: 'running'` so the
 * downstream ollama-block in getAllContainerStates fires and populates
 * `loadedModels` / `modelOnDisk`; status is then rewritten in-place by
 * `refineHostOllamaStatus` based on observable Ollama state.
 */
export function syntheticHostOllamaState(role: string, def: ContainerDef): ContainerState {
  return {
    exists: true,
    status: 'running',
    name: def.containerName,
    image: 'host-ollama',
    role,
    ports: [{ host: def.port, container: def.port }],
  } as ContainerState;
}

/**
 * Rewrite a host-runtime role's synthetic `status` from observable Ollama
 * state, after `loadedModels` / `modelOnDisk` have been populated.
 *
 *   `running`    — model is keep_alive'd in VRAM, serving traffic
 *   `unloaded`   — model is on disk but not loaded in VRAM
 *   `not_pulled` — model is not on disk yet (needs `ollama pull`)
 *
 * The master's UI badge and fleet-router both tolerate the new values:
 * fleet-router skips routing to anything that isn't strictly `running`,
 * and the admin UI falls through to a neutral badge for unknown statuses.
 *
 * Roles with no configured model stay at `running` (the operator opted
 * out of model-level lifecycle; nothing to verify).
 */
function refineHostOllamaStatus(s: ContainerState, def: ContainerDef): void {
  if (!def.model) return;
  const loaded = (s.loadedModels?.length ?? 0) > 0;
  if (loaded) {
    s.status = 'running';
    return;
  }
  if (s.modelOnDisk === true) {
    s.status = 'unloaded';
    return;
  }
  // Either modelOnDisk is explicitly false, or it was never set (tag fetch
  // failed / cache miss right after boot). In both cases the operator's
  // truthful next action is "pull". The heartbeat's own ollamaList call
  // will reconcile on the next cycle if it was just a transient miss.
  s.status = 'not_pulled';
}

/** Synthetic "running" state for a Docker Model Runner role. Identical
 *  shape to host-ollama — master's container-status routing keys on
 *  `status === 'running'` only. Image label `'dmr'` so admin UI can
 *  render the runtime correctly. */
export function syntheticDmrState(role: string, def: ContainerDef): ContainerState {
  return {
    exists: true,
    status: 'running',
    name: def.containerName,
    image: 'dmr',
    role,
    ports: [{ host: def.port, container: def.port }],
  } as ContainerState;
}

/**
 * Probe Docker Model Runner on the host. Updates state.dmrLastHealth.
 * Cheap — single GET /engines/v1/models with 5s timeout.
 */
async function probeDmr(role: string): Promise<boolean> {
  const started = Date.now();
  const { ready, error, modelCount } = await dmrIsReady();
  const at = Date.now();
  let classified: 'dns' | 'dmr_not_running' | 'network' | undefined;
  if (!ready) {
    if (error === 'ENOTFOUND' || error === 'EAI_AGAIN') classified = 'dns';
    else if (error === 'ECONNREFUSED') classified = 'dmr_not_running';
    else if (error) classified = 'network';
  }
  state.dmrLastHealth = { at, ok: ready, error: classified, latencyMs: at - started, modelCount };
  if (!ready) {
    log.warn(`DMR probe failed for ${role} at ${state.dmrHost}:${state.dmrPort} — ${classified || error || 'unknown'}`);
  }
  return ready;
}

/**
 * Probe the native Ollama on the Docker host for a host-runtime role.
 * Updates state.hostOllamaLastHealth as a side-effect. Returns true if
 * reachable. Cheap — single GET /api/tags with 5s timeout.
 */
async function probeHostOllama(role: string, def: ContainerDef): Promise<boolean> {
  const started = Date.now();
  const { ready, error } = await ollamaIsReady(def.port, role);
  const at = Date.now();
  let classified: 'dns' | 'ollama_not_running' | 'network' | undefined;
  if (!ready) {
    if (error === 'ENOTFOUND' || error === 'EAI_AGAIN') classified = 'dns';
    else if (error === 'ECONNREFUSED') classified = 'ollama_not_running';
    else if (error) classified = 'network';
  }
  state.hostOllamaLastHealth = { at, ok: ready, error: classified, latencyMs: at - started };
  if (!ready) {
    log.warn(`host-ollama probe failed for ${role} at ${state.hostOllamaHost}:${def.port} — ${classified || error || 'unknown'}`);
  }
  return ready;
}

/**
 * Ensure a container exists for a role: pull image + create if needed.
 */
export async function ensureContainerForRole(role: string): Promise<void> {
  const def = state.registry[role];
  if (!def) return;
  // Utility containers (e.g. cuda) are managed by their own modules (gpu.ts)
  if (def.type === 'utility') return;
  // Host-runtime roles: no Docker container to ensure. Probe reachability so
  // we surface a clear error if native Ollama isn't running on the host.
  if (def.runtime === 'host') {
    const ok = await probeHostOllama(role, def);
    if (!ok) {
      const err = state.hostOllamaLastHealth.error || 'unreachable';
      throw new Error(`host-ollama for ${role} not reachable at ${state.hostOllamaHost}:${def.port} (${err})`);
    }
    return;
  }
  // Docker Model Runner: probe DMR's TCP endpoint. No image pull, no
  // container create. If unreachable, surface an actionable error.
  if (def.runtime === 'docker-model-runner') {
    const ok = await probeDmr(role);
    if (!ok) {
      const err = state.dmrLastHealth.error || 'unreachable';
      const hint = err === 'dmr_not_running'
        ? `Enable Docker Model Runner in Docker Desktop (Settings → AI → Enable Docker Model Runner + Enable host-side TCP support on port ${state.dmrPort}).`
        : err === 'dns'
        ? `host.docker.internal cannot be resolved — check Docker networking.`
        : `Verify SS_DMR_HOST/SS_DMR_PORT and that Docker Model Runner is listening on TCP.`;
      throw new Error(
        `Docker Model Runner for ${role} not reachable at ${state.dmrHost}:${state.dmrPort} (${err}). ${hint}` +
        (def.model ? ` After enabling, run: docker model pull ${def.model}` : ''),
      );
    }
    if (def.model) {
      // DMR doesn't auto-pull on demand the way Ollama does — log a hint
      // so the operator knows to run `docker model pull` themselves.
      const known = await dmrListModels().catch(() => []);
      const modelBase = def.model.split(':')[0];
      const present = known.some((m) => m === def.model || m.includes(modelBase));
      if (!present) {
        log.warn(
          `DMR is reachable but model "${def.model}" is not in /engines/v1/models. ` +
          `Run on the Docker host: \`docker model pull ${def.model}\` (DMR has no auto-pull API).`,
        );
      }
    }
    return;
  }
  // Mac/Windows Docker has no GPU passthrough. Refuse to pull or create
  // containers that need it — they always fail with the CDI "no known GPU
  // vendor" error and put the sidecar into a retry loop that fills logs
  // and burns bandwidth (the nvidia/cuda image is ~200 MB, vllm is multi-GB).
  if (!dockerSupportsGpu()) {
    throw new Error(
      `Cannot provision ${role} (${def.type}) on this host: Docker has no GPU support on ${state.hostOs}. ` +
      `Options: SS_HOST_OLLAMA=1 (native Ollama, Ollama-protocol roles only), ` +
      `SS_DMR=1 (Docker Model Runner / vllm-metal on Apple Silicon, supports vLLM rerank), ` +
      `or move this role to a Linux+NVIDIA sidecar.`,
    );
  }
  const cs = await getContainerState(def.containerName);
  if (cs.exists) {
    const expected = buildExpectedConfig(role);
    const { hasDrift, drifts } = detectConfigDrift(cs, expected);
    if (hasDrift) {
      log.info(`Config drift detected for ${def.containerName}: ${drifts.join('; ')} — removing and recreating`);
      await removeContainer(def.containerName);
      // Fall through to pull + create below
    } else {
      return;
    }
  } else {
    log.info(`Auto-provisioning ${role} container (${def.containerName})...`);
  }
  try {
    await pullImage(def.image);
  } catch (err) {
    log.error(`Failed to pull ${def.image}: ${(err as Error).message}`);
    throw err;
  }
  await createContainer(role);
  log.info(`Container ${def.containerName} created`);
}

const log = createLogger('containers');

// Tracks the last remediation attempt for a gpuOnly role so the watchdog
// doesn't hammer Ollama when we're already in a known-bad state.
const REMEDIATE_COOLDOWN_MS = 60_000;
const lastRemediateAttempt: Record<string, number> = {};

/**
 * Free GPU VRAM in preparation for loading `role`.
 *
 * Delegates the policy decision to the eviction planner (which knows about
 * priorities, modes, runtimes, and per-role VRAM usage from the accountant)
 * and just executes the resulting plan.
 *
 * Returns the executed steps. Empty array means either (a) we already had
 * enough free VRAM, or (b) no eviction is permitted for this role.
 */
export async function evictForRole(role: string): Promise<EvictionStep[]> {
  const def = state.registry[role];
  if (!def) return [];
  // Only critical / gpuOnly roles get to evict. Other roles take whatever
  // VRAM is available; if not enough, Ollama will refuse the load and the
  // normal retry/back-off path handles it.
  const isCritical = def.priority === 'critical' || def.gpuOnly === true;
  if (!isCritical) return [];

  let snap;
  try {
    snap = await snapshotVram();
  } catch (err) {
    log.warn(`evictForRole(${role}): snapshot failed: ${(err as Error).message}`);
    return [];
  }
  const plan = planEviction(snap, role);
  if (plan.steps.length === 0) {
    if (plan.needMb === 0) {
      log.info(`evictForRole(${role}): no eviction needed (free=${snap.freeMb}MB, want=${def.vram + 1024}MB)`);
    } else {
      log.warn(`evictForRole(${role}): need ${plan.needMb}MB free but no legal eviction candidates`);
    }
    return [];
  }
  if (!plan.sufficient) {
    log.error(`evictForRole(${role}): plan can free only ${plan.totalFreedMb}MB of ${plan.needMb}MB needed; executing anyway`);
  } else {
    log.info(`evictForRole(${role}): plan freeing ${plan.totalFreedMb}MB via ${plan.steps.length} step(s) for ${plan.needMb}MB need`);
  }

  const executed: EvictionStep[] = [];
  for (const step of plan.steps) {
    const otherDef = state.registry[step.role];
    if (!otherDef) continue;
    try {
      if (step.action === 'unloadModel') {
        // Ollama: unload all models on this endpoint. Faster than docker stop.
        const ps = await ollamaPs(otherDef.port).catch(() => []);
        for (const m of ps) {
          await ollamaUnload(otherDef.port, m.name);
          log.info(`evict-for-${role}: unloaded ${m.name} on ${step.role} (~${step.expectedFreeMb}MB; ${step.reason})`);
        }
      } else if (step.action === 'stopContainer') {
        // vLLM and other runtimes: only docker stop releases VRAM.
        await stopContainer(otherDef.containerName);
        log.info(`evict-for-${role}: stopped ${otherDef.containerName} (~${step.expectedFreeMb}MB; ${step.reason})`);
      }
      executed.push(step);
    } catch (err) {
      log.warn(`evict-for-${role}: step ${step.action}/${step.role} failed: ${(err as Error).message}`);
    }
  }
  return executed;
}

/**
 * Load (or remediate) a gpuOnly model. Evicts other Ollama models first, then
 * forces full GPU residency. Returns true on verified GPU load. Sets gpuReady
 * on the per-role state via the caller's containerState.
 */
export async function loadGpuOnly(role: string): Promise<boolean> {
  const def = state.registry[role];
  if (!def || def.type !== 'ollama' || !def.model) return false;
  // Host-runtime: skip the eviction loop entirely. We can't `docker stop`
  // anything on the host's native Ollama (it isn't a container we own), and
  // the eviction planner's VRAM snapshot is built from `nvidia-smi`, which
  // doesn't exist on Mac. Ollama itself manages placement on the host; if it
  // can't fit, the load returns false and the caller retries on the normal
  // back-off path.
  if (def.runtime === 'host') {
    return ollamaLoad(def.port, def.model, { forceFullGpu: true, role });
  }
  // DMR: no manual load — DMR's scheduler spins up vllm-metal on first
  // request. Skip eviction (we don't own any host VRAM) and report ready
  // if DMR is reachable. The model itself isn't validated until a real
  // request hits /engines/v1/chat/completions.
  if (def.runtime === 'docker-model-runner') {
    const { ready } = await dmrIsReady();
    return ready;
  }
  const evicted = await evictForRole(role);
  if (evicted.length > 0) {
    // VRAM doesn't release instantly. unloadModel (Ollama keep_alive=0) frees
    // in ~1s; stopContainer (vLLM) needs longer for the kernel to reap the
    // CUDA context.
    const stoppedAny = evicted.some((s) => s.action === 'stopContainer');
    await new Promise((r) => setTimeout(r, stoppedAny ? 4_000 : 1_500));
  }
  const ok = await ollamaLoad(def.port, def.model, { forceFullGpu: true });
  if (ok) return true;
  // One retry: maybe a competing model loaded in between. Sweep again.
  log.info(`loadGpuOnly: ${role} first attempt failed, sweeping again`);
  const evicted2 = await evictForRole(role);
  if (evicted2.length > 0) {
    const stoppedAny2 = evicted2.some((s) => s.action === 'stopContainer');
    await new Promise((r) => setTimeout(r, stoppedAny2 ? 4_000 : 1_500));
  }
  return ollamaLoad(def.port, def.model, { forceFullGpu: true });
}

export async function getAllContainerStates(): Promise<Record<string, ContainerState>> {
  const states: Record<string, ContainerState> = {};
  for (const [role, def] of Object.entries(state.registry)) {
    // Host-runtime roles: synthesize a "running" state. No Docker inspect.
    if (def.runtime === 'host') {
      states[role] = syntheticHostOllamaState(role, def);
    } else if (def.runtime === 'docker-model-runner') {
      // DMR: synthesize running, list models from /engines/v1/models in
      // place of Ollama's /api/ps. We don't know which model is "loaded"
      // (DMR doesn't expose per-process VRAM) — just surface what's
      // available so the master can route.
      states[role] = syntheticDmrState(role, def);
      try {
        const known = await dmrListModels();
        states[role].loadedModels = known.map((name) => ({
          name,
          size: '?',
          sizeBytes: 0,
          sizeVram: 0,
          gpuPercent: undefined,
          processor: 'DMR',
          until: '',
        }));
        if (def.model) {
          const modelBase = def.model.split(':')[0];
          states[role].modelOnDisk = known.some((m) => m === def.model || m.includes(modelBase));
        }
      } catch {
        /* non-critical — leave loadedModels undefined */
      }
    } else {
      states[role] = await getContainerState(def.containerName);
      states[role].role = role;
    }
    states[role].config = { image: def.image, model: def.model, port: def.port, vram: def.vram, type: def.type, gpuOnly: def.gpuOnly };

    // Fetch loaded models for running Ollama containers via HTTP API.
    // Host-runtime roles share a single native Ollama endpoint on the host
    // (e.g. host.docker.internal:11434), so /api/ps and /api/tags return
    // EVERY model on that host — not just this role's. Filter to def.model
    // (exact tag or untagged base) so each role's loadedModels and
    // modelOnDisk reflect only its own model. Without this, completion's
    // status borrows embedding's loaded models and falsely reports
    // modelOnDisk=true. Cached helpers coalesce parallel per-role calls
    // to the same endpoint into one HTTP request per 30s.
    if (def.type === 'ollama' && states[role].status === 'running') {
      const isHostRuntime = def.runtime === 'host';
      const modelBase = def.model ? def.model.split(':')[0] : '';
      const matchesDefModel = (name: string): boolean => {
        if (!def.model) return false;
        if (name === def.model) return true;
        if (name === modelBase) return true;
        // Tolerate Ollama's habit of appending ":latest" or stripping it.
        if (modelBase && (name === `${modelBase}:latest` || `${modelBase}:latest` === def.model && name === modelBase)) return true;
        return false;
      };
      try {
        const psFetcher = isHostRuntime ? ollamaPsCached : ollamaPs;
        const psModelsRaw = await psFetcher(def.port, role);
        const psModels = isHostRuntime
          ? psModelsRaw.filter((m) => matchesDefModel(m.name))
          : psModelsRaw;
        const models = psModels.map(m => ({
          name: m.name,
          size: m.size ? `${Math.round(m.size / 1e9)}GB` : '?',
          sizeBytes: m.size,
          sizeVram: m.sizeVram,
          gpuPercent: m.size > 0 ? Math.round((m.sizeVram / m.size) * 100) : 0,
          processor: m.processor,
          until: m.until || '',
        }));
        states[role].loadedModels = models;
        // For host-runtime with no configured model, refuse to lie:
        // surface an empty list rather than the host-wide snapshot.
        if (isHostRuntime && !def.model) {
          states[role].loadedModels = [];
          states[role].modelOnDisk = false;
        }

        // Compute gpuReady for gpuOnly roles. Default true; flipped false if
        // any loaded model on this endpoint is partially on CPU.
        if (def.gpuOnly) {
          const offload = models.find(m => m.gpuPercent !== undefined && m.gpuPercent < 99);
          if (models.length === 0) {
            // Not loaded yet — heartbeat below will load it. Don't claim ready.
            states[role].gpuReady = false;
          } else if (offload) {
            states[role].gpuReady = false;
          } else {
            states[role].gpuReady = true;
          }
        }

        // Warn about CPU-offloaded models. For gpuOnly roles, also trigger
        // remediation: evict competitors + force-reload on GPU.
        for (const m of models) {
          const partial = m.gpuPercent !== undefined && m.gpuPercent < 99 && m.gpuPercent > 0;
          const allCpu = m.sizeBytes && m.sizeBytes > 0 && (!m.sizeVram || m.sizeVram === 0);
          if (partial) {
            log.warn(`CPU OFFLOAD: ${role} model ${m.name} is only ${m.gpuPercent}% in GPU VRAM (${m.processor}) — inference will be slow`);
          } else if (allCpu) {
            log.warn(`CPU OFFLOAD: ${role} model ${m.name} is running entirely on CPU — inference will be very slow`);
          }
          if (def.gpuOnly && (partial || allCpu) && !state.modelLoading.has(role)) {
            const last = lastRemediateAttempt[role] || 0;
            if (Date.now() - last >= REMEDIATE_COOLDOWN_MS) {
              lastRemediateAttempt[role] = Date.now();
              log.warn(`gpuOnly watchdog: ${role}/${m.name} on CPU — unloading and reloading with full GPU`);
              state.modelLoading.add(role);
              const remediateTaskId = tasks.start('model-load', `Remediate ${m.name} (force GPU)`, role);
              ollamaUnload(def.port, m.name, role)
                // Wait ~1.5s for VRAM to actually free; otherwise the planner's
                // snapshot inside loadGpuOnly still sees the old model in VRAM
                // and may over-evict.
                .then(() => new Promise((r) => setTimeout(r, 1_500)))
                .then(() => loadGpuOnly(role))
                .then((ok) => {
                  if (ok) tasks.complete(remediateTaskId);
                  else tasks.fail(remediateTaskId, 'Force-GPU reload failed (insufficient VRAM?)');
                })
                .catch((err) => tasks.fail(remediateTaskId, (err as Error).message))
                .finally(() => state.modelLoading.delete(role));
            }
          }
        }

        // Check if configured model is on disk (for UI status display).
        // Host-runtime: STRICT match (exact tag or untagged base, with the
        // implicit ":latest" tolerance Ollama applies). Substring matching
        // here would let `qwen3-embedding:0.6b` satisfy a `qwen3.5:14b`
        // check whenever the embedding model is the only thing on disk.
        if (def.model) {
          try {
            const listFetcher = isHostRuntime ? ollamaListCached : ollamaList;
            const diskModelsForCheck = await listFetcher(def.port, role);
            if (isHostRuntime) {
              states[role].modelOnDisk = diskModelsForCheck.some(matchesDefModel);
            } else {
              states[role].modelOnDisk = diskModelsForCheck.some(m => m.includes(modelBase));
            }
          } catch { /* non-critical */ }
        }

        // If configured model is not in VRAM, check it's on disk then load.
        // Guards: modelLoading (in-flight), active task for this role (running),
        // and cooldown (prevents retry spam after fast completions).
        const MODEL_ATTEMPT_COOLDOWN = 60_000;
        const model = def.model;
        const lastAttempt = state.lastModelAttempt[role] || 0;
        const hasActiveTask = tasks.getActive().some(t => t.role === role);
        const pullFails = state.pullFailCount[role] || 0;
        // Honor operator's minOnline=0 opt-out for background auto-load.
        // Without this, the heartbeat keeps pulling+loading models for roles
        // the operator has explicitly turned off.
        const optedOut = (state.minOnline?.[role] ?? 1) === 0;
        // Honor manual Stop: once the user clicks Stop on a host-runtime
        // role, the heartbeat would otherwise see `status: 'running'` +
        // `models.length === 0` and immediately reload within 60s. Skip
        // until the next manual Acquire/Start clears state.userStopped.
        const userStopped = state.userStopped.has(role);
        if ((optedOut || userStopped) && model && models.length === 0) {
          const reason = optedOut ? 'minOnline=0' : 'manually stopped';
          log.info(`heartbeat: skipping ${role} auto-load — ${reason} (operator opted out)`);
        }
        if (!optedOut && !userStopped && model && models.length === 0 && !state.modelLoading.has(role) && !hasActiveTask && (Date.now() - lastAttempt) > MODEL_ATTEMPT_COOLDOWN && pullFails < 3) {
          log.info(`heartbeat: ${role} model ${model} not in VRAM (0 models loaded), checking disk...`);
          state.lastModelAttempt[role] = Date.now();
          const modelBase = model.split(':')[0];
          try {
            const diskModels = await ollamaList(def.port, role);
            log.info(`heartbeat: ollama list → ${diskModels.length} models: ${diskModels.join(', ')}`);
            const onDisk = diskModels.some(m => m.includes(modelBase));
            if (onDisk) {
              // Model on disk but not in VRAM — load it
              log.info(`heartbeat: ${model} on disk but not in VRAM — loading${def.gpuOnly ? ' (gpuOnly: evict + force GPU)' : ''}...`);
              state.pullFailCount[role] = 0; // on disk = pull succeeded at some point
              state.modelLoading.add(role);
              const loadTaskId = tasks.start('model-load', `Load ${model} into VRAM`, role);
              const loadPromise = def.gpuOnly
                ? loadGpuOnly(role)
                : ollamaLoad(def.port, model, {
                    onProgress: (detail) => tasks.update(loadTaskId, { detail: detail.slice(0, 100) }),
                    role,
                  });
              loadPromise.then((ok) => {
                if (ok) tasks.complete(loadTaskId);
                else tasks.fail(loadTaskId, def.gpuOnly ? 'GPU-only load failed (insufficient VRAM?)' : 'Load returned false');
              }).catch((err) => {
                tasks.fail(loadTaskId, (err as Error).message);
              }).finally(() => {
                state.modelLoading.delete(role);
              });
            } else {
              // Model not even on disk — pull then load
              log.info(`heartbeat: ${model} not on disk, pulling via HTTP API...`);
              state.modelLoading.add(role);
              const pullTaskId = tasks.start('model-pull', `Pull ${model}`, role);
              log.info(`heartbeat: STARTING PULL of ${model} on port ${def.port} (taskId=${pullTaskId})`);
              ollamaPull(def.port, model, {
                onProgress: (pct, detail) => {
                  log.info(`heartbeat: pull progress: ${pct}% ${detail.slice(0, 80)}`);
                  tasks.update(pullTaskId, { progress: pct, detail: detail.slice(0, 80) });
                },
                role,
              })
                .then(async () => {
                  // Post-pull verification
                  const verifyModels = await ollamaList(def.port, role);
                  log.info(`heartbeat: post-pull verify → ${verifyModels.join(', ')}`);
                  if (!verifyModels.some(m => m.includes(modelBase))) {
                    tasks.fail(pullTaskId, 'Model not found on disk after pull');
                    log.error(`heartbeat: ${model} not found on disk after pull`);
                    state.pullFailCount[role] = (state.pullFailCount[role] || 0) + 1;
                    if (state.pullFailCount[role] >= 3) {
                      log.warn(`heartbeat: pull of ${model} failed 3 times, not retrying until config change or restart`);
                    }
                    return;
                  }
                  state.pullFailCount[role] = 0;
                  tasks.complete(pullTaskId);
                  log.info(`heartbeat: ${model} pulled and verified, loading into VRAM${def.gpuOnly ? ' (gpuOnly)' : ''}...`);
                  const loadTaskId = tasks.start('model-load', `Load ${model} into VRAM`, role);
                  const loadPromise = def.gpuOnly
                    ? loadGpuOnly(role)
                    : ollamaLoad(def.port, model, {
                        onProgress: (detail) => tasks.update(loadTaskId, { detail: detail.slice(0, 100) }),
                        role,
                      });
                  return loadPromise.then((ok) => {
                    if (ok) tasks.complete(loadTaskId);
                    else tasks.fail(loadTaskId, def.gpuOnly ? 'GPU-only load failed (insufficient VRAM?)' : 'Load returned false');
                  }).catch((err) => {
                    tasks.fail(loadTaskId, (err as Error).message);
                    throw err;
                  });
                })
                .catch((err) => {
                  if (tasks.getActive().some(t => t.id === pullTaskId)) {
                    tasks.fail(pullTaskId, (err as Error).message);
                  }
                  state.pullFailCount[role] = (state.pullFailCount[role] || 0) + 1;
                  log.error(`heartbeat: pull+load ${model} failed (${state.pullFailCount[role]}x): ${(err as Error).message}`);
                  if (state.pullFailCount[role] >= 3) {
                    log.warn(`heartbeat: pull of ${model} failed 3 times, not retrying until config change or restart`);
                  }
                })
                .finally(() => {
                  state.modelLoading.delete(role);
                });
            }
          } catch {
            // ollama list failed — skip this cycle
          }
        }
      } catch {
        // Non-critical — leave loadedModels undefined
      }
    }

    // Host-runtime post-processing: rewrite the synthetic `status` from
    // `'running'` to one of `running`/`unloaded`/`not_pulled` based on the
    // loadedModels / modelOnDisk fields the ollama-block just populated.
    // The synthesizer has to lie initially because the gate above keys on
    // `status === 'running'` to trigger that population — chicken-and-egg.
    if (def.runtime === 'host') {
      refineHostOllamaStatus(states[role], def);
    }
  }
  return states;
}

/**
 * Roles currently assigned to this sidecar. The legacy "indexing vs searching"
 * mode toggle has been removed — per-host mode tags now live in the master's
 * HostRoleAssignment table and arrive via the WS /config push. This function
 * is kept for back-compat with any internal call sites that still expect a
 * list of active role names; it returns every non-utility role in the
 * (already-trimmed) registry. The master is the source of truth.
 */
export function containersForMode(_mode?: string): string[] {
  // Honor minOnline=0 opt-out so callers don't auto-start opted-out roles.
  return Object.entries(state.registry)
    .filter(([role, def]) => def.type !== 'utility' && (state.minOnline?.[role] ?? 1) > 0)
    .map(([role]) => role);
}

/**
 * Legacy mode switch — neutered. The "indexing vs searching" model has been
 * replaced by per-host role assignments (HostRoleAssignment table on the
 * master). Old masters and old UI clients may still POST /api/mode; we
 * accept the call, persist the requested mode label for back-compat
 * (so /api/status doesn't drift), and otherwise do nothing.
 *
 * Real role activation/deactivation now happens via the registry trim in
 * ws-client.ts when the master pushes its per-host enabledModes set.
 */
export async function switchMode(newMode: string): Promise<Record<string, unknown>> {
  if (newMode !== 'indexing' && newMode !== 'searching') {
    return { error: `Invalid mode: ${newMode} (legacy field; use /admin/roleassign for per-host role tags instead)` };
  }
  const previous = state.currentMode;
  state.currentMode = newMode as 'indexing' | 'searching';
  saveConfig();
  log.info(`Mode label set to ${newMode} (legacy no-op — was ${previous}; roles are governed by per-host assignment now)`);
  return {
    mode: newMode,
    started: {},
    stopped: {},
    message: 'Mode label persisted but no longer controls roles. Use /admin/roleassign on the master to enable/disable roles per host.',
  };
}

export async function provisionContainers(): Promise<Record<string, Record<string, string>>> {
  const results: Record<string, Record<string, string>> = {};
  const pulledImages = new Set<string>();

  for (const [role, def] of Object.entries(state.registry)) {
    // Utility containers (e.g. cuda) are managed by their own modules (gpu.ts)
    if (def.type === 'utility') continue;
    results[role] = { image: 'skipped', container: 'skipped', model: 'skipped' };

    // Mac/Windows: refuse to pull/create any GPU container. The image pulls
    // alone are gigabytes and the containers will never start.
    if (def.runtime !== 'host' && def.runtime !== 'docker-model-runner' && !dockerSupportsGpu()) {
      results[role].image = 'skipped-no-gpu';
      results[role].container = `skipped-no-gpu (host=${state.hostOs}; try SS_HOST_OLLAMA=1 or SS_DMR=1)`;
      continue;
    }

    // Docker Model Runner: no image pull, no container create. Probe
    // reachability and hint at `docker model pull` if model is missing.
    if (def.runtime === 'docker-model-runner') {
      results[role].image = 'docker-model-runner';
      results[role].container = 'docker-model-runner';
      try {
        await ensureContainerForRole(role); // probes DMR + logs pull hint
        results[role].model = def.model ? 'managed-by-dmr' : 'no-model';
      } catch (err) {
        results[role].model = `error: ${(err as Error).message}`;
      }
      continue;
    }

    // Host-runtime: no Docker image to pull, no container to create. Probe
    // reachability and pull the model on the host Ollama if needed.
    if (def.runtime === 'host') {
      results[role].image = 'host-runtime';
      results[role].container = 'host-runtime';
      try {
        await ensureContainerForRole(role); // probes host Ollama
        if (def.model) {
          await waitForOllama(def.port, 30_000, role);
          await ollamaPull(def.port, def.model, { role });
          results[role].model = 'pulled';
          log.info(`Model ${def.model} pulled for ${role} on host Ollama`);
        }
      } catch (err) {
        results[role].model = `error: ${(err as Error).message}`;
      }
      continue;
    }

    try {
      if (!pulledImages.has(def.image)) {
        // Check if image exists locally — skip pull if so
        const { status: imgStatus } = await dockerRequest('GET', `/images/${encodeURIComponent(def.image)}/json`);
        if (imgStatus === 200) {
          pulledImages.add(def.image);
          results[role].image = 'exists';
        } else {
          await pullImage(def.image);
          pulledImages.add(def.image);
          results[role].image = 'pulled';
        }
      } else {
        results[role].image = 'exists';
      }
    } catch (err) {
      results[role].image = `error: ${(err as Error).message}`;
      continue;
    }

    try {
      await createContainer(role);
      results[role].container = 'created';
    } catch (err) {
      if ((err as Error).message.includes('already exists')) {
        results[role].container = 'exists';
      } else {
        results[role].container = `error: ${(err as Error).message}`;
        continue;
      }
    }

    if (def.type === 'ollama' && def.model) {
      try {
        await startContainer(def.containerName);
        await waitForOllama(def.port);
        await ollamaPull(def.port, def.model);
        results[role].model = 'pulled';
        log.info(`Model ${def.model} pulled for ${role}`);
      } catch (err) {
        results[role].model = `error: ${(err as Error).message}`;
      }
    }
  }
  return results;
}

/**
 * Stop (NOT remove) any ss-* docker container whose name doesn't match an
 * entry in the current registry. Called after every config push that updates
 * state.registry — when an operator removes a role from a host on
 * /admin/roleassign, the live docker container would otherwise keep running
 * (and keep holding VRAM) because the sidecar no longer iterates it.
 *
 * We STOP rather than REMOVE: preserves the container's config + pulled
 * image so a future re-assignment can `docker start` it back up quickly
 * without re-pulling. Operator can `docker rm` manually if they really
 * want the disk space.
 *
 * Returns the list of containers that were stopped this sweep (for logging
 * + /api/status surfacing).
 */
export interface OrphanInfo {
  name: string;
  image: string;
  previousState: string; // "running" before we stopped it
}
export async function stopOrphanContainers(): Promise<OrphanInfo[]> {
  if (!dockerSupportsGpu() && state.hostOs !== 'linux' && state.hostOs !== 'windows-docker-wsl2') {
    // Host runtimes (mac-docker-ollama) don't manage docker containers for
    // model roles; there's nothing to sweep. Linux + WSL2 always sweep.
    return [];
  }
  let candidates;
  try {
    candidates = await listContainersByPrefix(CONTAINER_PREFIX);
  } catch (err) {
    log.warn(`stopOrphanContainers: list failed: ${(err as Error).message}`);
    return [];
  }
  // Names the sidecar still claims, plus the sidecar's own container so we
  // never accidentally stop ourselves.
  const claimed = new Set<string>();
  for (const def of Object.values(state.registry)) {
    if (def.containerName) claimed.add(def.containerName);
  }
  claimed.add(`${CONTAINER_PREFIX}sidecar`);
  claimed.add(state.CONTAINER_NAME);

  const stopped: OrphanInfo[] = [];
  for (const c of candidates) {
    if (claimed.has(c.name)) continue;
    if (c.state !== 'running') continue;
    log.info(`Orphan sweep: stopping unassigned container ${c.name} (image=${c.image}, was ${c.state})`);
    try {
      await stopContainer(c.name);
      stopped.push({ name: c.name, image: c.image, previousState: c.state });
    } catch (err) {
      log.warn(`Orphan sweep: failed to stop ${c.name}: ${(err as Error).message}`);
    }
  }
  if (stopped.length > 0) {
    log.info(`Orphan sweep: stopped ${stopped.length} container(s) not in current registry`);
  }
  return stopped;
}

/**
 * Snapshot of orphan containers for /api/status — every ss-* container the
 * sidecar doesn't claim, regardless of state. Lets the master surface them
 * in /admin/gpu so the operator can choose to re-assign the role (and the
 * container restarts) or manually `docker rm` to reclaim disk.
 */
export async function listOrphanContainers(): Promise<Array<{
  name: string;
  image: string;
  state: string;
  status: string;
}>> {
  let candidates;
  try {
    candidates = await listContainersByPrefix(CONTAINER_PREFIX);
  } catch {
    return [];
  }
  const claimed = new Set<string>();
  for (const def of Object.values(state.registry)) {
    if (def.containerName) claimed.add(def.containerName);
  }
  claimed.add(`${CONTAINER_PREFIX}sidecar`);
  claimed.add(state.CONTAINER_NAME);
  return candidates
    .filter((c) => !claimed.has(c.name))
    .map((c) => ({ name: c.name, image: c.image, state: c.state, status: c.status }));
}
