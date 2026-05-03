import { state } from './state';
import { getContainerState, startContainer, stopContainer, removeContainer, pullImage, createContainer, dockerRequest, buildExpectedConfig, detectConfigDrift, type ContainerState } from './docker';
import { ollamaPs, ollamaList, ollamaPull, ollamaLoad, ollamaUnload, waitForOllama } from './ollama-api';
import { snapshotVram } from './vram-accountant';
import { planEviction, type EvictionStep } from './eviction-planner';
import { clearIdleTimerForRole } from './idle-timers';
import { saveConfig } from './config';
import { createLogger } from './logger';
import { tasks } from './task-tracker';

/**
 * Ensure a container exists for a role: pull image + create if needed.
 */
async function ensureContainerForRole(role: string): Promise<void> {
  const def = state.registry[role];
  if (!def) return;
  // Utility containers (e.g. cuda) are managed by their own modules (gpu.ts)
  if (def.type === 'utility') return;
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
    states[role] = await getContainerState(def.containerName);
    states[role].role = role;
    states[role].config = { image: def.image, model: def.model, port: def.port, vram: def.vram, type: def.type, gpuOnly: def.gpuOnly };

    // Fetch loaded models for running Ollama containers via HTTP API
    if (def.type === 'ollama' && states[role].status === 'running') {
      try {
        const psModels = await ollamaPs(def.port);
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
              ollamaUnload(def.port, m.name)
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

        // Check if configured model is on disk (for UI status display)
        if (def.model) {
          try {
            const diskModelsForCheck = await ollamaList(def.port);
            const modelBase = def.model.split(':')[0];
            states[role].modelOnDisk = diskModelsForCheck.some(m => m.includes(modelBase));
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
        if (model && models.length === 0 && !state.modelLoading.has(role) && !hasActiveTask && (Date.now() - lastAttempt) > MODEL_ATTEMPT_COOLDOWN && pullFails < 3) {
          log.info(`heartbeat: ${role} model ${model} not in VRAM (0 models loaded), checking disk...`);
          state.lastModelAttempt[role] = Date.now();
          const modelBase = model.split(':')[0];
          try {
            const diskModels = await ollamaList(def.port);
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
              })
                .then(async () => {
                  // Post-pull verification
                  const verifyModels = await ollamaList(def.port);
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
  }
  return states;
}

/**
 * Roles that should run in a given mode.
 *
 * Union of:
 *   1. Roles whose registry definition includes this mode (the original semantic)
 *   2. Roles with minOnline >= 1 (operator override — must run regardless of mode)
 *
 * minOnline=0 takes precedence: switchMode further filters those out so an
 * opt-out wins even when the registry says the role belongs in this mode.
 */
export function containersForMode(mode: string): string[] {
  const fromRegistry = Object.entries(state.registry)
    .filter(([, def]) => def.modes.includes(mode as 'indexing' | 'searching'))
    .map(([role]) => role);
  const forced = Object.entries(state.minOnline)
    .filter(([role, n]) => (n ?? 0) > 0 && state.registry[role])
    .map(([role]) => role);
  return Array.from(new Set([...fromRegistry, ...forced]));
}

export async function switchMode(newMode: string): Promise<Record<string, unknown>> {
  if (newMode !== 'indexing' && newMode !== 'searching') {
    throw new Error(`Invalid mode: ${newMode}`);
  }
  if (newMode === state.currentMode) return { mode: state.currentMode, message: 'Already in this mode' };

  const oldRoles = containersForMode(state.currentMode);
  const newRoles = containersForMode(newMode);
  // A role with minOnline>=1 stays running across mode switches — the operator
  // policy overrides the mode definition. Only stop roles that are absent from
  // the new mode AND have no min-online floor.
  const toStop = oldRoles.filter((r) => !newRoles.includes(r) && (state.minOnline[r] ?? 0) === 0);
  // Honor master-pushed minOnline=0 — never auto-start a role the operator
  // has explicitly opted out of. The role can still be started on-demand
  // via /acquire from a real request; this only suppresses mode-switch starts.
  const skipped = newRoles.filter((r) => !oldRoles.includes(r) && (state.minOnline[r] ?? 1) === 0);
  const toStart = newRoles.filter((r) => !oldRoles.includes(r) && (state.minOnline[r] ?? 1) > 0);

  log.info(`Switching mode: ${state.currentMode} -> ${newMode}`);
  log.info(`Stop: ${toStop.join(', ') || 'none'} | Start: ${toStart.join(', ') || 'none'}${skipped.length ? ` | Skipped (minOnline=0): ${skipped.join(', ')}` : ''}`);

  // Start new containers first
  const startResults: Record<string, string> = {};
  for (const role of toStart) {
    try {
      await ensureContainerForRole(role);
      const cs = await getContainerState(state.registry[role].containerName);
      if (cs.status === 'running') {
        startResults[role] = 'already_running';
      } else {
        await startContainer(state.registry[role].containerName);
        startResults[role] = 'started';
      }
    } catch (err) {
      startResults[role] = `error: ${(err as Error).message}`;
    }
  }

  // Drain containers to stop (wait up to 10s for active requests)
  const stopResults: Record<string, string> = {};
  for (const role of toStop) {
    if (state.perRole[role].activeRequests > 0) {
      log.info(`Draining ${role} (${state.perRole[role].activeRequests} active requests)...`);
      const deadline = Date.now() + 10_000;
      while (state.perRole[role].activeRequests > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    try {
      clearIdleTimerForRole(role);
      await stopContainer(state.registry[role].containerName);
      stopResults[role] = 'stopped';
    } catch (err) {
      stopResults[role] = `error: ${(err as Error).message}`;
    }
  }

  state.currentMode = newMode as 'indexing' | 'searching';
  saveConfig();
  log.info(`Mode switched to ${newMode}`);
  return { mode: newMode, started: startResults, stopped: stopResults };
}

export async function provisionContainers(): Promise<Record<string, Record<string, string>>> {
  const results: Record<string, Record<string, string>> = {};
  const pulledImages = new Set<string>();

  for (const [role, def] of Object.entries(state.registry)) {
    // Utility containers (e.g. cuda) are managed by their own modules (gpu.ts)
    if (def.type === 'utility') continue;
    results[role] = { image: 'skipped', container: 'skipped', model: 'skipped' };

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
