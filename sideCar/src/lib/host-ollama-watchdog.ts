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

import http from 'http';
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

/** Fallback for Mac sidecars where the registry hasn't yet been populated with
 *  runtime='host' roles (e.g. boot before the master's mode-templates push, or
 *  a legacy master that pushes a raw registry without a runtime field). On
 *  mac-docker-ollama the native Ollama is at host.docker.internal:11434 by
 *  convention, so we can still probe it. Returns null on non-Mac hosts. */
function pickMacFallback(): { role: string; port: number } | null {
  if (state.hostOs !== 'mac-docker-ollama') return null;
  // Use a synthetic role label so error messages are clear; getDockerHost
  // ignores the role when the registry entry isn't host-runtime, so we
  // bypass it below by talking directly to state.hostOllamaHost.
  return { role: '__mac_fallback__', port: 11434 };
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

/** Direct HTTP probe of state.hostOllamaHost:port/api/tags, bypassing the
 *  role-based getDockerHost() lookup. Used when the registry has no
 *  runtime='host' role yet but we still want to report Mac native-Ollama
 *  health (mac-docker-ollama path before the master's mode-templates push,
 *  or legacy master that pushes a registry without runtime fields). */
function probeMacDirect(port: number, timeoutMs = 5_000): Promise<{ ready: boolean; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: state.hostOllamaHost, port, method: 'GET', path: '/api/tags' },
      (res) => {
        // Drain the body so the socket can close; we only care about status.
        res.on('data', () => { /* drain */ });
        res.on('end', () => resolve({ ready: res.statusCode === 200 }));
      },
    );
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ ready: false, error: code || err.message });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ready: false, error: 'ETIMEDOUT' });
    });
    req.end();
  });
}

async function probeOnce(): Promise<void> {
  const started = Date.now();
  try {
    let pick = pickHostRuntimeRole();
    let usedFallback = false;
    if (!pick) {
      pick = pickMacFallback();
      usedFallback = pick !== null;
    }
    if (!pick) {
      // No host-runtime roles AND not Mac — nothing to probe. Mark stale-but-
      // clean so the master sees `at` advance (proves the watchdog is alive)
      // and `ok:false` with a descriptive error.
      state.hostOllamaLastHealth = { at: Date.now(), ok: false, error: 'no-host-roles' };
      return;
    }
    const { ready, error } = usedFallback
      ? await probeMacDirect(pick.port)
      : await ollamaIsReady(pick.port, pick.role);
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
  } catch (err) {
    // Defensive: any unexpected throw (e.g. registry mutation mid-probe)
    // must still update lastHealth.at so the master can tell the watchdog
    // is alive. Without this, `at` stays 0 and the master thinks the
    // sidecar never probed.
    const at = Date.now();
    state.hostOllamaLastHealth = { at, ok: false, error: 'network', latencyMs: at - started };
    log.warn(`host-ollama probe threw: ${(err as Error).message}`);
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

/** True iff any registry role currently routes to a host runtime. Used as a
 *  fallback gate when SS_HOST_OLLAMA env wasn't set but the master pushed a
 *  mode-templates registry with `runtime: 'host'` (mac-docker-ollama path).
 *  Without this, a Mac sidecar running without the env var never starts the
 *  watchdog and lastHealth stays {at:0, ok:false} forever. */
function hasHostRuntimeRole(): boolean {
  for (const def of Object.values(state.registry)) {
    if (def.runtime === 'host' || def.runtime === 'docker-model-runner') return true;
  }
  return false;
}

/** True on hosts where the native Ollama endpoint is part of the architecture,
 *  regardless of whether the registry has been populated yet. Currently:
 *  mac-docker-ollama. This lets the watchdog start at boot and write a
 *  meaningful lastHealth BEFORE the master's first config push lands —
 *  without this, `lastHealth.at` stays 0 forever on a fresh Mac sidecar. */
function hostNeedsWatchdog(): boolean {
  return state.hostOs === 'mac-docker-ollama';
}

export function startHostOllamaWatchdog(): void {
  if (timer) return;
  const shouldRun =
    state.hostOllamaEnabled ||
    state.dmrEnabled ||
    hasHostRuntimeRole() ||
    hostNeedsWatchdog();
  if (!shouldRun) {
    log.info('host-runtime watchdog disabled (no SS_HOST_OLLAMA/SS_DMR env, no host-runtime roles in registry, hostOs not mac-docker-ollama)');
    return;
  }
  log.info(
    `host-runtime watchdog starting (probe every ${PROBE_INTERVAL_MS / 1000}s; reconcile every ${(PROBE_INTERVAL_MS * RECONCILE_EVERY_N_TICKS) / 1000}s; ` +
    `hostOllama=${state.hostOllamaEnabled}, dmr=${state.dmrEnabled}, registryHostRole=${hasHostRuntimeRole()}, hostOs=${state.hostOs})`,
  );
  // Probe immediately at startup so /api/status reflects reality quickly.
  // Probe Ollama whenever a host-runtime role exists OR we're on a Mac sidecar
  // (in which case probeOnce uses the mac-fallback path to hit
  // host.docker.internal:11434 directly).
  const ollamaShouldProbe = () =>
    state.hostOllamaEnabled || hasHostRuntimeRole() || hostNeedsWatchdog();
  if (ollamaShouldProbe()) void probeOnce();
  if (state.dmrEnabled) void probeDmrOnce();
  timer = setInterval(() => {
    tickCount++;
    if (ollamaShouldProbe()) void probeOnce();
    if (state.dmrEnabled) void probeDmrOnce();
    // Reconcile only makes sense when at least one host-runtime role is in
    // the registry — the mac-fallback path has no roles to reconcile against.
    if (tickCount % RECONCILE_EVERY_N_TICKS === 0 && (state.hostOllamaEnabled || hasHostRuntimeRole())) {
      void reconcileOnce();
    }
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
