import { state } from './state';
import { getContainerState, startContainer, stopContainer, removeContainer, pullImage, createContainer, dockerRequest, buildExpectedConfig, detectConfigDrift, type ContainerState } from './docker';
import { ollamaPs, ollamaList, ollamaPull, ollamaLoad, waitForOllama } from './ollama-api';
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

export async function getAllContainerStates(): Promise<Record<string, ContainerState>> {
  const states: Record<string, ContainerState> = {};
  for (const [role, def] of Object.entries(state.registry)) {
    states[role] = await getContainerState(def.containerName);
    states[role].role = role;
    states[role].config = { image: def.image, model: def.model, port: def.port, vram: def.vram, type: def.type };

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

        // Warn about CPU-offloaded models
        for (const m of models) {
          if (m.gpuPercent !== undefined && m.gpuPercent < 99 && m.gpuPercent > 0) {
            log.warn(`CPU OFFLOAD: ${role} model ${m.name} is only ${m.gpuPercent}% in GPU VRAM (${m.processor}) — inference will be slow`);
          } else if (m.sizeBytes && m.sizeBytes > 0 && (!m.sizeVram || m.sizeVram === 0)) {
            log.warn(`CPU OFFLOAD: ${role} model ${m.name} is running entirely on CPU — inference will be very slow`);
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
              log.info(`heartbeat: ${model} on disk but not in VRAM — loading...`);
              state.pullFailCount[role] = 0; // on disk = pull succeeded at some point
              state.modelLoading.add(role);
              const loadTaskId = tasks.start('model-load', `Load ${model} into VRAM`, role);
              ollamaLoad(def.port, model, {
                onProgress: (detail) => tasks.update(loadTaskId, { detail: detail.slice(0, 100) }),
              }).then((ok) => {
                if (ok) tasks.complete(loadTaskId);
                else tasks.fail(loadTaskId, 'Load returned false');
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
                  log.info(`heartbeat: ${model} pulled and verified, loading into VRAM...`);
                  const loadTaskId = tasks.start('model-load', `Load ${model} into VRAM`, role);
                  return ollamaLoad(def.port, model, {
                    onProgress: (detail) => tasks.update(loadTaskId, { detail: detail.slice(0, 100) }),
                  }).then((ok) => {
                    if (ok) tasks.complete(loadTaskId);
                    else tasks.fail(loadTaskId, 'Load returned false');
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

export function containersForMode(mode: string): string[] {
  return Object.entries(state.registry)
    .filter(([, def]) => def.modes.includes(mode as 'indexing' | 'searching'))
    .map(([role]) => role);
}

export async function switchMode(newMode: string): Promise<Record<string, unknown>> {
  if (newMode !== 'indexing' && newMode !== 'searching') {
    throw new Error(`Invalid mode: ${newMode}`);
  }
  if (newMode === state.currentMode) return { mode: state.currentMode, message: 'Already in this mode' };

  const oldRoles = containersForMode(state.currentMode);
  const newRoles = containersForMode(newMode);
  const toStop = oldRoles.filter((r) => !newRoles.includes(r));
  const toStart = newRoles.filter((r) => !oldRoles.includes(r));

  log.info(`Switching mode: ${state.currentMode} -> ${newMode}`);
  log.info(`Stop: ${toStop.join(', ') || 'none'} | Start: ${toStart.join(', ') || 'none'}`);

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
