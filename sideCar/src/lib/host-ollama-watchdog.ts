/**
 * Host-Ollama health watchdog.
 *
 * When SS_HOST_OLLAMA=1, one Ollama process on the Docker host (reached via
 * host.docker.internal:11434) serves every role with `runtime: 'host'`. The
 * watchdog probes that endpoint on a fixed interval and updates
 * state.hostOllamaLastHealth with a classified result:
 *
 *   ok = true                              → reachable, /api/tags returned 200
 *   error = 'dns'                          → host.docker.internal won't resolve
 *                                            (Docker Desktop networking broken)
 *   error = 'ollama_not_running'           → TCP refused (Ollama not running)
 *   error = 'network'                      → timeout / other transport error
 *
 * Every 4th tick (~60 s) it also runs `ollama ps` and reconciles
 * state.modelLoading — if a model we think we loaded is missing from /api/ps
 * (e.g. user restarted Ollama out-of-band), we drop the flag so the next
 * acquire re-warms.
 *
 * Cheap: one `GET /api/tags` per tick. Off when SS_HOST_OLLAMA is unset.
 */

import { state } from './state';
import { ollamaIsReady, ollamaPs } from './ollama-api';
import { dmrIsReady } from './dmr-api';
import { createLogger } from './logger';

const log = createLogger('host-runtime-watchdog');

const PROBE_INTERVAL_MS = 15_000;
const RECONCILE_EVERY_N_TICKS = 4; // ≈ every 60 s

let timer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;

/** Find any role currently configured as host-runtime. The host endpoint is
 *  shared across all such roles, so any one of them is sufficient for the
 *  probe URL. Returns null if none — watchdog will idle. */
function pickHostRuntimeRole(): { role: string; port: number } | null {
  for (const [role, def] of Object.entries(state.registry)) {
    if (def.runtime === 'host' && def.type === 'ollama') return { role, port: def.port };
  }
  return null;
}

async function probeDmrOnce(): Promise<void> {
  if (!state.dmrEnabled) return;
  const started = Date.now();
  const { ready, error, modelCount } = await dmrIsReady();
  const at = Date.now();
  let classified: 'dns' | 'dmr_not_running' | 'network' | undefined;
  if (!ready) {
    if (error === 'ENOTFOUND' || error === 'EAI_AGAIN') classified = 'dns';
    else if (error === 'ECONNREFUSED') classified = 'dmr_not_running';
    else if (error) classified = 'network';
  }
  const prevOk = state.dmrLastHealth.ok;
  state.dmrLastHealth = { at, ok: ready, error: classified, latencyMs: at - started, modelCount };
  if (ready && !prevOk) {
    log.info(`DMR recovered: ${state.dmrHost}:${state.dmrPort} reachable (${at - started}ms, ${modelCount ?? '?'} models)`);
  } else if (!ready && prevOk) {
    log.warn(`DMR went unreachable: ${state.dmrHost}:${state.dmrPort} — ${classified || error}`);
  }
}

async function probeOnce(): Promise<void> {
  const pick = pickHostRuntimeRole();
  if (!pick) {
    // No host-runtime roles — nothing to probe. Mark stale-but-clean.
    state.hostOllamaLastHealth = { at: Date.now(), ok: false, error: 'no-host-roles' };
    return;
  }
  const started = Date.now();
  const { ready, error } = await ollamaIsReady(pick.port, pick.role);
  const at = Date.now();
  let classified: 'dns' | 'ollama_not_running' | 'network' | undefined;
  if (!ready) {
    if (error === 'ENOTFOUND' || error === 'EAI_AGAIN') classified = 'dns';
    else if (error === 'ECONNREFUSED') classified = 'ollama_not_running';
    else if (error) classified = 'network';
  }
  const prevOk = state.hostOllamaLastHealth.ok;
  state.hostOllamaLastHealth = { at, ok: ready, error: classified, latencyMs: at - started };
  if (ready && !prevOk) {
    log.info(`host-ollama recovered: ${state.hostOllamaHost}:${pick.port} reachable (${at - started}ms)`);
  } else if (!ready && prevOk) {
    log.warn(`host-ollama went unreachable: ${state.hostOllamaHost}:${pick.port} — ${classified || error}`);
  }
}

async function reconcileOnce(): Promise<void> {
  const pick = pickHostRuntimeRole();
  if (!pick || !state.hostOllamaLastHealth.ok) return;
  let loaded: Awaited<ReturnType<typeof ollamaPs>>;
  try {
    loaded = await ollamaPs(pick.port, pick.role);
  } catch (err) {
    log.warn(`reconcile: ollamaPs failed: ${(err as Error).message}`);
    return;
  }
  const loadedNames = new Set(loaded.map(m => m.name));
  // Clear stale modelLoading flags for host-runtime roles whose model is no
  // longer in /api/ps. The next acquire will re-warm.
  for (const role of Array.from(state.modelLoading)) {
    const def = state.registry[role];
    if (def?.runtime !== 'host' || !def.model) continue;
    const modelBase = def.model.split(':')[0];
    const stillLoaded = Array.from(loadedNames).some(n => n === def.model || n.includes(modelBase));
    if (!stillLoaded) {
      log.info(`reconcile: clearing stale modelLoading flag for ${role} — ${def.model} not in /api/ps`);
      state.modelLoading.delete(role);
    }
  }
}

export function startHostOllamaWatchdog(): void {
  if (timer) return;
  if (!state.hostOllamaEnabled && !state.dmrEnabled) {
    log.info('host-runtime watchdog disabled (neither SS_HOST_OLLAMA nor SS_DMR set)');
    return;
  }
  log.info(
    `host-runtime watchdog starting (probe every ${PROBE_INTERVAL_MS / 1000}s; reconcile every ${(PROBE_INTERVAL_MS * RECONCILE_EVERY_N_TICKS) / 1000}s; ` +
    `hostOllama=${state.hostOllamaEnabled}, dmr=${state.dmrEnabled})`,
  );
  // Probe immediately at startup so /api/status reflects reality quickly.
  if (state.hostOllamaEnabled) void probeOnce();
  if (state.dmrEnabled) void probeDmrOnce();
  timer = setInterval(() => {
    tickCount++;
    if (state.hostOllamaEnabled) void probeOnce();
    if (state.dmrEnabled) void probeDmrOnce();
    if (tickCount % RECONCILE_EVERY_N_TICKS === 0 && state.hostOllamaEnabled) void reconcileOnce();
  }, PROBE_INTERVAL_MS);
}

export function stopHostOllamaWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    tickCount = 0;
    log.info('host-runtime watchdog stopped');
  }
}
