/**
 * Reranker deep-health watchdog.
 *
 * Background: vLLM workers can deadlock such that /health returns 200 and
 * /v1/models lists the model, but /v1/rerank hangs forever. The master's
 * existing preflight checks /health which is insufficient — the only reliable
 * probe is to actually post a 1-doc rerank.
 *
 * This module runs a 60 s interval in the master process that does that deep
 * probe against every connected sidecar advertising a running vLLM reranker.
 * Hosts that fail 3 consecutive probes are auto-restarted via the sidecar's
 * /stop + /start endpoints (the same path the admin UI uses). Hosts that
 * deadlock more than 3 times in 24 h are marked chronic-unhealthy and
 * auto-restart is suppressed pending operator investigation.
 *
 * The verdict is exposed via getRerankerHostHealth() so fleet-router can
 * skip unhealthy hosts when picking a candidate for a real rerank.
 *
 * Known limitation: if the sidecar reports the stop returned a docker
 * "zombie container" error, we log and skip — the container needs manual
 * `docker rm` on that host because the name is fixed and create-while-zombie
 * will 409. The longer-term fix is the Init: true change in
 * sideCar/src/lib/docker.ts (vLLM containers need tini as PID-1 to forward
 * SIGTERM to the Python worker tree).
 */

import { createLogger } from '@/lib/logger';
import { getConfig } from '@/lib/db/config';
import { getFleetStatus, sendToSidecar } from '@/lib/gpu/fleet-router';

const logger = createLogger('reranker-watchdog');

const PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const SUSPECT_THRESHOLD = 1;
const UNHEALTHY_THRESHOLD = 3;
const COOLDOWN_MS = 90_000;
const RESTART_WAIT_AFTER_STOP_MS = 5_000;
const RESTART_WAIT_AFTER_START_MS = 60_000;
const CHRONIC_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHRONIC_RESTART_THRESHOLD = 3; // > 3 → chronic

export type HealthState =
  | 'healthy'
  | 'suspect'
  | 'unhealthy'
  | 'restarting'
  | 'cooldown'
  | 'chronic-unhealthy';

interface HostRecord {
  sidecarUrl: string;
  hostname: string;
  rerankUrl: string;          // http://host:8099
  state: HealthState;
  consecutiveFails: number;
  lastProbeAt: number | null;
  lastSuccessAt: number | null;
  lastError?: string;
  cooldownUntil: number;
  restarts: number[];         // ms timestamps within last 24h
}

const hosts = new Map<string, HostRecord>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let started = false;

function pruneRestarts(rec: HostRecord): void {
  const cutoff = Date.now() - CHRONIC_WINDOW_MS;
  rec.restarts = rec.restarts.filter(t => t >= cutoff);
}

function publicSnapshot(rec: HostRecord) {
  pruneRestarts(rec);
  return {
    url: rec.sidecarUrl,
    hostname: rec.hostname,
    state: rec.state,
    lastProbeAt: rec.lastProbeAt,
    lastSuccessAt: rec.lastSuccessAt,
    consecutiveFails: rec.consecutiveFails,
    restarts24h: rec.restarts.length,
    lastError: rec.lastError,
  };
}

/** Exposed to fleet-router. */
export function getRerankerHostHealth(): Record<string, HealthState> {
  const out: Record<string, HealthState> = {};
  for (const rec of hosts.values()) out[rec.sidecarUrl] = rec.state;
  return out;
}

/** Read-only admin snapshot. */
export function getRerankerHealthSnapshot() {
  return Array.from(hosts.values()).map(publicSnapshot);
}

/**
 * Deep probe: POST /v1/rerank with a 1-doc payload. Times out at 10s.
 * Returns ok=true only on HTTP 200 with a numeric relevance_score.
 */
async function deepProbe(rerankUrl: string, model: string): Promise<{ ok: boolean; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${rerankUrl}/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        query: 'ping',
        documents: ['ping'],
        top_n: 1,
        return_documents: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null) as { results?: Array<{ relevance_score?: number }> } | null;
    const score = data?.results?.[0]?.relevance_score;
    if (typeof score !== 'number' || Number.isNaN(score)) {
      return { ok: false, error: 'invalid score in response' };
    }
    return { ok: true };
  } catch (err) {
    const e = err as Error;
    const msg = e.name === 'AbortError' ? `probe timeout after ${PROBE_TIMEOUT_MS}ms` : e.message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Issue stop+start to the host's sidecar. */
async function restartHost(rec: HostRecord): Promise<{ ok: boolean; error?: string }> {
  pruneRestarts(rec);
  if (rec.restarts.length > CHRONIC_RESTART_THRESHOLD) {
    rec.state = 'chronic-unhealthy';
    logger.warn(
      `This reranker has deadlocked ${rec.restarts.length + 1}+ times in 24h — investigate vLLM logs on ${rec.hostname}. Auto-restart suppressed.`,
      { sidecar: rec.sidecarUrl }
    );
    return { ok: false, error: 'chronic-unhealthy: auto-restart suppressed' };
  }

  rec.state = 'restarting';
  logger.warn(`Auto-restarting reranker on ${rec.hostname}`, {
    sidecar: rec.sidecarUrl,
    priorRestarts24h: rec.restarts.length,
  });

  // Stop
  try {
    const stopResult = await sendToSidecar(rec.sidecarUrl, '/stop', { role: 'reranker' }, 'POST', 30_000);
    const stopErr = (stopResult && (stopResult.error || stopResult.message)) as string | undefined;
    if (stopErr && /zombie/i.test(String(stopErr))) {
      logger.warn(
        `cannot stop reranker container on ${rec.hostname}: docker reports zombie. May need manual 'docker rm -f ss-reranker' — skipping restart cycle.`,
        { sidecar: rec.sidecarUrl, stopErr }
      );
      rec.lastError = `stop returned zombie: ${stopErr}`;
      rec.state = 'unhealthy';
      return { ok: false, error: 'zombie container' };
    }
  } catch (err) {
    logger.warn(`stop failed on ${rec.hostname}`, { error: (err as Error).message });
    // Proceed anyway — start may still succeed if container is already gone.
  }

  await new Promise(r => setTimeout(r, RESTART_WAIT_AFTER_STOP_MS));

  // Start
  try {
    await sendToSidecar(rec.sidecarUrl, '/start', { role: 'reranker' }, 'POST', 30_000);
  } catch (err) {
    rec.state = 'unhealthy';
    rec.lastError = `start failed: ${(err as Error).message}`;
    logger.warn(`start failed on ${rec.hostname}`, { error: (err as Error).message });
    return { ok: false, error: rec.lastError };
  }

  rec.restarts.push(Date.now());
  // Give vLLM cold-start time before our next probe.
  await new Promise(r => setTimeout(r, RESTART_WAIT_AFTER_START_MS));

  rec.state = 'cooldown';
  rec.cooldownUntil = Date.now() + COOLDOWN_MS;
  rec.consecutiveFails = 0;
  logger.info(`Restart complete on ${rec.hostname}, entering cooldown`, { sidecar: rec.sidecarUrl });
  return { ok: true };
}

/** Discover currently-eligible reranker hosts from the fleet. */
async function discoverHosts(): Promise<HostRecord[]> {
  const fleet = await getFleetStatus().catch((err) => {
    logger.warn('fleet discovery failed', { error: (err as Error).message });
    return null;
  });
  if (!fleet) return [];

  const found: HostRecord[] = [];
  for (const s of fleet.sidecars) {
    if (s.status !== 'connected') continue;
    const cs = (s.sidecarStatus as { containers?: Record<string, { status?: string; image?: string }> } | undefined)
      ?.containers?.reranker;
    if (!cs) continue;
    if (cs.status !== 'running') continue;
    if (cs.image === 'dmr' || cs.image === 'host-ollama') continue;

    let hostname: string;
    try {
      hostname = new URL(s.url).hostname;
    } catch { continue; }
    const rerankUrl = `http://${hostname}:8099`;

    let rec = hosts.get(s.url);
    if (!rec) {
      rec = {
        sidecarUrl: s.url,
        hostname: s.hostname || hostname,
        rerankUrl,
        state: 'healthy',
        consecutiveFails: 0,
        lastProbeAt: null,
        lastSuccessAt: null,
        cooldownUntil: 0,
        restarts: [],
      };
      hosts.set(s.url, rec);
    } else {
      // Refresh URL/hostname (e.g. IP change)
      rec.rerankUrl = rerankUrl;
      rec.hostname = s.hostname || hostname;
    }
    found.push(rec);
  }
  return found;
}

async function probeAndHandle(rec: HostRecord, model: string): Promise<void> {
  // Skip while restart in flight — restartHost manages its own state.
  if (rec.state === 'restarting') return;
  // While in chronic-unhealthy, still probe to detect recovery, but never restart.
  // While in cooldown, only probe after cooldownUntil.
  if (rec.state === 'cooldown' && Date.now() < rec.cooldownUntil) return;

  rec.lastProbeAt = Date.now();
  const result = await deepProbe(rec.rerankUrl, model);
  if (result.ok) {
    if (rec.state !== 'healthy') {
      logger.info(`reranker recovered: ${rec.hostname} → healthy`, {
        sidecar: rec.sidecarUrl,
        priorState: rec.state,
      });
    }
    rec.state = 'healthy';
    rec.consecutiveFails = 0;
    rec.lastSuccessAt = Date.now();
    rec.lastError = undefined;
    return;
  }

  rec.consecutiveFails++;
  rec.lastError = result.error;
  logger.warn(`deep probe failed on ${rec.hostname} (${rec.consecutiveFails} consecutive)`, {
    sidecar: rec.sidecarUrl,
    error: result.error,
  });

  if (rec.state === 'chronic-unhealthy') {
    // No auto-restart; just keep recording fails.
    return;
  }

  if (rec.consecutiveFails >= UNHEALTHY_THRESHOLD) {
    rec.state = 'unhealthy';
    // Dispatch restart (don't await — but we DO want to know when it's done
    // before the next tick; restartHost handles state transitions atomically).
    await restartHost(rec).catch(err => {
      logger.warn(`restart dispatch failed on ${rec.hostname}`, { error: (err as Error).message });
    });
  } else if (rec.consecutiveFails >= SUSPECT_THRESHOLD) {
    rec.state = 'suspect';
  }
}

async function runTick(opts: { fastTrackUnhealthy?: boolean } = {}): Promise<void> {
  let model: string;
  try {
    const cfg = await getConfig();
    if (!cfg.rerankEnabled || cfg.rerankProvider === 'none') return;
    model = cfg.rerankModel || 'Qwen/Qwen3-Reranker-8B';
  } catch (err) {
    logger.warn('config load failed', { error: (err as Error).message });
    return;
  }

  const active = await discoverHosts();
  if (active.length === 0) return;

  // Run probes in parallel — a deadlocked host can't slow the others down.
  await Promise.all(active.map(rec => probeAndHandle(rec, model).catch(err => {
    logger.warn(`probe error on ${rec.hostname}`, { error: (err as Error).message });
  })));

  if (opts.fastTrackUnhealthy) {
    // Boot-time pass: anything already unhealthy gets restarted now without
    // waiting for the next 60s tick. probeAndHandle above already triggers
    // restartHost when it crosses UNHEALTHY_THRESHOLD in one shot only if
    // consecutiveFails accumulates — so on boot we may have just 1 fail
    // recorded. Treat boot-time as a hard signal: if probe failed, restart.
    for (const rec of active) {
      if (rec.state === 'suspect' || rec.state === 'unhealthy') {
        logger.warn(`boot-time fast-track restart of ${rec.hostname} (state=${rec.state})`, {
          sidecar: rec.sidecarUrl,
        });
        rec.state = 'unhealthy';
        await restartHost(rec).catch(err => {
          logger.warn(`fast-track restart failed on ${rec.hostname}`, { error: (err as Error).message });
        });
      }
    }
  }
}

/**
 * Idempotent. Starts the 60s interval and kicks off an immediate pass that
 * fast-tracks restart of any host already deadlocked at boot.
 */
export function startRerankerWatchdog(): void {
  if (started) return;
  started = true;
  logger.info('starting reranker watchdog (60s interval)');

  // Boot-time pass: settle for ~5s to let fleet discovery come online, then
  // run a tick that fast-tracks restart on the first failure.
  setTimeout(() => {
    runTick({ fastTrackUnhealthy: true }).catch(err => {
      logger.warn('boot tick failed', { error: (err as Error).message });
    });
  }, 5_000);

  intervalHandle = setInterval(() => {
    runTick().catch(err => logger.warn('tick failed', { error: (err as Error).message }));
  }, PROBE_INTERVAL_MS);
}

export function stopRerankerWatchdog(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  started = false;
}
