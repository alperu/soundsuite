import { state } from './state';
import { stopContainer } from './docker';
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
  const containerName = state.registry[role]?.containerName || state.CONTAINER_NAME;
  log.info(`Starting idle timer for ${role}: ${timeoutMs / 1000}s`);
  state.perRole[role].idleTimer = setTimeout(async () => {
    if (state.perRole[role].activeRequests > 0) {
      startIdleTimerForRole(role);
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
