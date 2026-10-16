/**
 * "Update Ollama" for a docker-ollama role: force-pull the role's image and
 * recreate its container on the new image.
 *
 * Why a recreate: every Ollama role uses the bare `ollama/ollama` tag
 * (= :latest). pullImage() skips the pull when the tag is already present,
 * and a running container keeps the image ID it was created from, so a host
 * can sit on an old Ollama indefinitely (e.g. 0.24.0, which cannot load
 * newer model families). detectConfigDrift compares image *names*, so it
 * never notices.
 *
 * The models live in the `ollama-models` named volume, so removing the
 * container keeps every pulled model.
 *
 * Runs in the background with a Tasks entry; a multi-GB image pull outlasts
 * any master command timeout.
 */
import { state } from './state';
import { getContainerState, getImageId, pullImage, removeContainer, startContainer, isDockerAvailable } from './docker';
import { ensureContainerForRole } from './containers';
import { leaseSummary } from './leases';
import { tasks } from './task-tracker';
import { createLogger } from './logger';
import { processGlobal } from './process-global';

const log = createLogger('ollama-image-update');

const G = processGlobal('ollamaImageUpdate', () => ({
  updating: new Set<string>(),
}));

function busyReason(role: string): string | null {
  const active = state.perRole[role]?.activeRequests ?? 0;
  const leases = leaseSummary().byRole[role]?.open ?? 0;
  if (active > 0 || leases > 0) {
    return `${role} is serving requests (active=${active}, leases=${leases}) — retry when idle`;
  }
  return null;
}

export async function handleUpdateImage(role: string | undefined): Promise<Record<string, unknown>> {
  if (!role) return { error: 'role is required' };
  const def = state.registry[role];
  if (!def) return { error: `Unknown role: ${role}` };
  if (def.type !== 'ollama' || def.runtime === 'host' || def.runtime === 'docker-model-runner'
    || !def.image || def.image === 'host-ollama' || def.image === 'dmr') {
    return { error: `${role} is not a docker-ollama role — nothing to update here` };
  }
  if (!isDockerAvailable()) return { error: 'Docker is not reachable on this host' };
  if (G.updating.has(role)) return { error: `Ollama update for ${role} already in progress` };
  const busy = busyReason(role);
  if (busy) return { error: busy };

  G.updating.add(role);
  const taskId = tasks.start('image-pull', `Update Ollama (${def.image})`, role);
  runUpdate(role, taskId)
    .catch((err) => {
      tasks.fail(taskId, (err as Error).message);
      log.error(`Ollama update for ${role} failed: ${(err as Error).message}`);
    })
    .finally(() => G.updating.delete(role));

  return { ok: true, message: `Updating Ollama image for ${role} — progress in Tasks` };
}

async function runUpdate(role: string, taskId: string): Promise<void> {
  const def = state.registry[role];
  const name = def.containerName;
  const before = await getContainerState(name);

  log.info(`Ollama update ${role}: force-pulling ${def.image}`);
  const ok = await pullImage(def.image, {
    force: true,
    onProgress: (pct, detail) => tasks.update(taskId, { progress: pct, detail: detail.slice(0, 80) }),
  });
  if (!ok) throw new Error(`pull of ${def.image} failed`);

  const newId = await getImageId(def.image);
  if (before.exists && before.imageId && newId && before.imageId === newId) {
    log.info(`Ollama update ${role}: ${name} already on newest ${def.image}`);
    tasks.update(taskId, { progress: 100, detail: 'Already on newest image' });
    tasks.complete(taskId);
    return;
  }

  // Re-check: a request may have arrived during the pull. Removing the
  // container now would kill it mid-inference.
  const busy = busyReason(role);
  if (busy) throw new Error(`image pulled, recreate skipped: ${busy}`);

  const wasRunning = before.status === 'running';
  tasks.update(taskId, { progress: 100, detail: `Recreating ${name}` });
  if (before.exists) await removeContainer(name);
  await ensureContainerForRole(role);
  // Restore the prior state only — never start a container the operator
  // (or minOnline=0) had stopped.
  if (wasRunning) await startContainer(name);
  log.info(`Ollama update ${role}: ${name} recreated on ${newId?.slice(7, 19) ?? def.image}${wasRunning ? ' and started' : ''}`);
  tasks.complete(taskId);
}

/** Test seam. */
export function __resetImageUpdateForTest(): void {
  G.updating.clear();
}
