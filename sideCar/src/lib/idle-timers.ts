import { state } from './state';
import { stopContainer } from './docker';
import { ollamaUnload } from './ollama-api';
import { createLogger } from './logger';

const log = createLogger('idle-timer');

export function clearIdleTimerForRole(role: string): void {
  if (state.perRole[role]?.idleTimer) {
    clearTimeout(state.perRole[role].idleTimer!);
    state.perRole[role].idleTimer = null;
    log.debug(`Cleared idle timer for ${role}`);
  }
}

export function clearAllIdleTimers(): void {
  for (const role of Object.keys(state.perRole)) clearIdleTimerForRole(role);
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

export function getIdleTimeoutForRole(role: string): number {
  if (role && state.idleTimeouts[role] !== undefined) return state.idleTimeouts[role];
  return state.idleTimeouts.reranker || state.IDLE_TIMEOUT_MS;
}

export function startIdleTimerForRole(role: string): void {
  clearIdleTimerForRole(role);
  const timeoutMs = getIdleTimeoutForRole(role);
  if (timeoutMs <= 0) {
    log.info(`Idle timer disabled for role "${role}" (timeout=0)`);
    return;
  }
  const def = state.registry[role];
  const containerName = def?.containerName || state.CONTAINER_NAME;
  log.info(`Starting idle timer for ${role}: ${timeoutMs / 1000}s`);
  state.perRole[role].idleTimer = setTimeout(async () => {
    if (state.perRole[role].activeRequests > 0) {
      startIdleTimerForRole(role);
      return;
    }
    // minOnline guard: if operator requires >=1 instance of this role on this
    // sidecar, never auto-stop. The master's enforceMinOnline loop would just
    // re-acquire 30s later anyway, eating a cold-start (~30-60s) and breaking
    // searches during the gap. Honor the operator intent and keep the
    // container resident. Idle-stop only applies when minOnline=0.
    const minOnline = state.minOnline?.[role] ?? 0;
    if (minOnline >= 1) {
      log.info(`Idle for ${timeoutMs / 1000}s (role: ${role}) — keeping resident (minOnline=${minOnline})`);
      state.perRole[role].idleTimer = null;
      return;
    }
    // Host-runtime: evict the model from native Ollama's VRAM via
    // keep_alive: 0 instead of `docker stop`. The Ollama process keeps
    // running; only this role's model is unloaded. Other host-runtime roles
    // sharing the same Ollama are unaffected (keep_alive is keyed by model).
    // Docker Model Runner: no unload API. Log and bail — DMR's scheduler
    // owns eviction. Leaving the model loaded is safe; idle DMR workers
    // get reaped by DMR itself on memory pressure.
    if (def?.runtime === 'docker-model-runner') {
      log.info(`Idle for ${timeoutMs / 1000}s (role: ${role}) — DMR has no unload API, model stays loaded (deferred to v2)`);
      return;
    }
    if (def?.runtime === 'host' && def.model) {
      log.info(`Idle for ${timeoutMs / 1000}s (role: ${role}) — unloading ${def.model} from host Ollama`);
      try {
        const ok = await ollamaUnload(def.port, def.model, role);
        log.info(`host-ollama unload ${def.model}: ${ok ? 'ok — VRAM freed' : 'returned non-200 (best-effort)'}`);
      } catch (err) {
        log.error(`Failed to unload ${def.model} from host Ollama: ${(err as Error).message}`);
      }
      return;
    }
    log.info(`Idle for ${timeoutMs / 1000}s (role: ${role}) — stopping container ${containerName}`);
    try {
      await stopContainer(containerName);
      log.info(`Container ${containerName} stopped — GPU VRAM freed`);
    } catch (err) {
      log.error(`Failed to stop ${containerName}: ${(err as Error).message}`);
    }
  }, timeoutMs);
}

// Legacy single-timer compat
export function clearIdleTimer(): void { clearAllIdleTimers(); }
export function startIdleTimer(role?: string): void { startIdleTimerForRole(role || 'reranker'); }
