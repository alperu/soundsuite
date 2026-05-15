/**
 * Reranker Container Lifecycle Manager
 *
 * Manages the vLLM reranker Docker container via a sidecar agent.
 * The sidecar agent runs on the GPU machine alongside Docker and exposes
 * a simple HTTP API for container lifecycle management.
 *
 * Supports dual-mode communication:
 * 1. Direct HTTP — when the sidecar is reachable on the network
 * 2. WebSocket tunnel — when behind NAT/firewall, routes through ws-relay
 *
 * The agent handles:
 * - Starting/stopping the container via Docker socket
 * - Per-role idle timers (auto-stop after configurable timeout)
 * - Active request counting (coalesced startup)
 *
 * This module is a thin HTTP client that talks to the agent.
 */

import { createLogger } from '@/lib/logger';
import * as wsRelay from '@/lib/gpu/ws-relay';

const logger = createLogger('RerankerLifecycle');

const HEALTH_CHECK_INTERVAL_MS = 2_000;
const MAX_STARTUP_WAIT_MS = 180_000; // 3 minutes — model loading can be slow
const AGENT_PORT = parseInt(process.env.RERANKER_AGENT_PORT || '8098', 10);

type LifecycleState = 'unknown' | 'stopped' | 'starting' | 'ready' | 'stopping';

interface PerModelIdleTimeouts {
  embedding: number;
  completion: number;
  ocr: number;
  reranker: number;
}

class RerankerLifecycle {
  private state: LifecycleState = 'unknown';
  private startPromise: Promise<void> | null = null;
  private agentBase: string | null = null; // e.g. "http://10.10.20.5:8098"
  private enabled = true;
  private configPushed = false;
  private lastStartError: { at: number; error: Error } | null = null;
  private static START_FAIL_TTL_MS = 5_000;
  private idleTimeoutMs = 5 * 60 * 1000;
  private idleTimeouts: PerModelIdleTimeouts = {
    embedding: 0,
    completion: 10 * 60 * 1000,
    ocr: 5 * 60 * 1000,
    reranker: 5 * 60 * 1000,
  };
  // Heartbeat loop — pings the sidecar's /touch endpoint to re-arm its idle
  // timer so the reranker container isn't auto-stopped during quiet periods.
  // Paired with the sidecar's minOnline guard (idle-timers.ts), this means
  // an operator with minOnline=1 + active master gets zero unexpected stops.
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  private static HEARTBEAT_INTERVAL_MS = 60_000;

  /**
   * Ensure the reranker container is running and healthy.
   * Call before making rerank requests.
   */
  async ensureRunning(host: string): Promise<void> {
    if (!this.enabled) return;

    // Try fleet router first if orchestrator is enabled for reranker
    if (!this.agentBase) {
      try {
        const { getConfig } = await import('@/lib/db/config');
        const config = await getConfig();
        if (config.rerankUseOrchestrator) {
          const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
          const ep = await resolveEndpoint('reranker');
          this.agentBase = ep.sidecarUrl;
          logger.info('Reranker agent resolved via fleet router', { agent: this.agentBase });
        }
      } catch {
        // Fleet router not available — fall through to legacy resolution
      }
    }

    // Derive agent URL from the reranker host (same IP, agent port)
    this.resolveAgentBase(host);
    if (!this.agentBase) return;

    // Generic short-circuit: if the master's status cache already shows
    // the reranker container as running on this sidecar, /acquire is
    // gratuitous — the vLLM endpoint is up and ready to serve. Skip
    // /acquire (which would also try to "ensure container running" + bump
    // activeRequests) and verify health directly. This works regardless
    // of why /acquire might fail — missing docker.sock, sidecar
    // restarting, transient network blip, etc. — because the rerank
    // traffic itself is independent of /acquire.
    if (await this.rerankerAlreadyRunning()) {
      logger.info(
        `Reranker container already running on ${this.agentBase} — skipping /acquire, probing endpoint health directly`,
      );
      if (await this.isHealthy(host)) {
        this.state = 'ready';
        this.startHeartbeat('reranker');
        return;
      }
      // Container "running" per the sidecar's report but endpoint isn't
      // responding — fall through to the normal acquire path which will
      // restart it. Honest signal that something's actually wrong.
      logger.warn(
        `Reranker container reported running but ${host} health probe failed — falling through to /acquire`,
      );
    }

    // Push config to agent on first call (or after changes)
    if (!this.configPushed) {
      await this.pushConfig();
    }

    // If ready, verify health
    if (this.state === 'ready') {
      if (await this.isHealthy(host)) {
        await this.sendToSidecar('/acquire', 'POST', { role: 'reranker' });
        this.startHeartbeat('reranker');
        return;
      }
      logger.warn('Container was marked ready but health check failed — restarting');
      this.state = 'stopped';
    }

    // If currently stopping, wait for that to finish first
    if (this.state === 'stopping') {
      const deadline = Date.now() + 10_000;
      while (this.state === 'stopping' && Date.now() < deadline) {
        await sleep(500);
      }
    }

    // If already starting, piggyback on the in-flight promise
    if (this.state === 'starting' && this.startPromise) {
      await this.startPromise;
      return;
    }

    // Short-circuit: if a recent start attempt failed, don't hammer the sidecar.
    // 6 parallel deep-search rerank calls would otherwise all retry /acquire.
    if (this.lastStartError && Date.now() - this.lastStartError.at < RerankerLifecycle.START_FAIL_TTL_MS) {
      throw this.lastStartError.error;
    }

    // Start via agent and wait for health
    this.state = 'starting';
    this.startPromise = this.acquireAndWaitForHealth(host);

    try {
      await this.startPromise;
      this.lastStartError = null;
    } catch (err) {
      this.lastStartError = { at: Date.now(), error: err as Error };
      throw err;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * Mark a rerank request as completed.
   * Call in a finally block after the rerank HTTP call.
   */
  markRequestDone(): void {
    if (!this.agentBase) return;
    // Use fleet router release if available, otherwise direct
    import('@/lib/gpu/fleet-router').then(({ releaseEndpoint }) => {
      releaseEndpoint('reranker', this.agentBase!);
    }).catch(() => {
      // Fallback to direct release
      this.sendToSidecar('/release', 'POST', { role: 'reranker' }).catch((err) => {
        logger.warn('Failed to release reranker', { error: (err as Error).message });
      });
    });
  }

  /** Configure idle timeout (legacy single value). */
  setIdleTimeout(ms: number): void {
    if (ms > 0 && ms !== this.idleTimeoutMs) {
      this.idleTimeoutMs = ms;
      this.idleTimeouts.reranker = ms;
      this.configPushed = false;
    }
  }

  /** Configure per-model idle timeouts (in ms). */
  setIdleTimeouts(timeouts: Partial<PerModelIdleTimeouts>): void {
    let changed = false;
    for (const [role, ms] of Object.entries(timeouts)) {
      const key = role as keyof PerModelIdleTimeouts;
      if (typeof ms === 'number' && ms >= 0 && this.idleTimeouts[key] !== ms) {
        this.idleTimeouts[key] = ms;
        changed = true;
      }
    }
    if (changed) {
      this.configPushed = false;
    }
  }

  /** Enable or disable lifecycle management. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Immediately stop the container via agent. */
  async stopNow(): Promise<void> {
    if (!this.agentBase) return;
    this.state = 'stopping';
    try {
      await this.sendToSidecar('/stop', 'POST', { role: 'reranker' });
      this.state = 'stopped';
      logger.info('Reranker container stopped via agent — GPU VRAM freed');
    } catch (err) {
      logger.error('Failed to stop via agent', err instanceof Error ? err : new Error(String(err)));
      this.state = 'unknown';
    }
  }

  /** Current lifecycle state (for diagnostics / admin UI). */
  getState(): { state: LifecycleState; agentBase: string | null } {
    return { state: this.state, agentBase: this.agentBase };
  }

  /**
   * Start the heartbeat loop. Idempotent — calling repeatedly is safe.
   * Fires immediately, then every HEARTBEAT_INTERVAL_MS until stopped.
   * Errors are swallowed (heartbeat is best-effort; the sidecar's minOnline
   * guard is the real safety net).
   */
  startHeartbeat(role: string = 'reranker'): void {
    if (this.heartbeatHandle) return;
    const tick = () => {
      if (!this.agentBase) return;
      this.sendToSidecar('/touch', 'POST', { role }).catch((err) => {
        logger.debug('heartbeat /touch failed (non-fatal)', { error: (err as Error).message });
      });
    };
    tick();
    this.heartbeatHandle = setInterval(tick, RerankerLifecycle.HEARTBEAT_INTERVAL_MS);
    if (typeof this.heartbeatHandle === 'object' && this.heartbeatHandle && 'unref' in this.heartbeatHandle) {
      (this.heartbeatHandle as unknown as { unref: () => void }).unref();
    }
    logger.info('Reranker heartbeat started', { intervalMs: RerankerLifecycle.HEARTBEAT_INTERVAL_MS });
  }

  /** Stop the heartbeat loop. Safe to call when not running. */
  stopHeartbeat(): void {
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
      logger.info('Reranker heartbeat stopped');
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────

  /** Derive agent base URL from the reranker host URL. */
  private resolveAgentBase(rerankHost: string): void {
    if (this.agentBase) return;
    try {
      const u = new URL(rerankHost);
      const host = u.hostname;
      this.agentBase = `http://${host}:${AGENT_PORT}`;
      logger.info('Reranker lifecycle: using sidecar agent', { agent: this.agentBase });
    } catch {
      logger.warn('Failed to parse reranker host URL, lifecycle disabled', { host: rerankHost });
    }
  }

  /** Push config (per-model idle timeouts, minOnline, container name) to the agent. */
  private async pushConfig(): Promise<void> {
    try {
      // Best-effort: read app config so we can include minOnline. If unreachable
      // (e.g. early boot), fall back to idle-timeouts only.
      let minOnline: Record<string, number> | undefined;
      try {
        const { getConfig } = await import('@/lib/db/config');
        const cfg = await getConfig();
        minOnline = {
          embedding: cfg.gpuMinEmbedding ?? 1,
          completion: cfg.gpuMinCompletion ?? 0,
          ocr: cfg.gpuMinOcr ?? 1,
          reranker: cfg.gpuMinReranker ?? 1,
        };
      } catch { /* best-effort */ }

      await this.sendToSidecar('/config', 'POST', {
        idleTimeouts: {
          embedding: this.idleTimeouts.embedding,
          completion: this.idleTimeouts.completion,
          ocr: this.idleTimeouts.ocr,
          reranker: this.idleTimeouts.reranker,
        },
        ...(minOnline ? { minOnline } : {}),
      });
      this.configPushed = true;
    } catch (err) {
      // Not critical — agent has defaults
      logger.warn('Failed to push config to agent', { error: (err as Error).message });
    }
  }

  /**
   * Returns true when the master's status cache shows the reranker
   * container as already `status: 'running'` on this sidecar. When that's
   * the case, /acquire would just confirm what we already know AND
   * increment activeRequests — gratuitous work, with the downside that
   * any /acquire failure (no docker.sock, restarting sidecar, transient
   * blip) generates a noisy WARN+ERROR pair even though the rerank
   * endpoint itself works fine.
   *
   * Generic over the failure mode: we don't care WHY /acquire might fail.
   * If the container is up, skip /acquire and probe the endpoint directly.
   *
   * Uses the master's status cache (fed by sidecar heartbeats). Falls
   * back to false when no cache entry is available yet — first contact
   * lets /acquire run normally to warm things up.
   */
  private async rerankerAlreadyRunning(): Promise<boolean> {
    if (!this.agentBase) return false;
    try {
      const { getSidecarStatus } = await import('@/lib/gpu/status-cache');
      const cached = getSidecarStatus(this.agentBase);
      const container = cached?.containers?.reranker;
      if (!container) return false;
      // 'running' means vLLM is serving — exactly the condition where
      // /acquire's "ensure container running" goal is already met.
      return container.status === 'running';
    } catch {
      return false;
    }
  }

  /**
   * Send a command to the sidecar agent, auto-detecting the best mode:
   * 1. Try direct HTTP first (fast, low latency)
   * 2. Fall back to WebSocket tunnel if HTTP fails (NAT/firewall)
   */
  private async sendToSidecar(path: string, method: string, body?: object): Promise<any> {
    if (!this.agentBase) throw new Error('No agent base URL');

    // Try direct HTTP first
    try {
      const url = `${this.agentBase}/api${path}`;
      const opts: RequestInit = {
        method,
        signal: AbortSignal.timeout(5_000),
      };
      if (body) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(url, opts);
      return res.json();
    } catch {
      // Direct HTTP failed — try WebSocket tunnel
    }

    // Fall back to WebSocket tunnel
    if (wsRelay.hasSidecarConnection(this.agentBase)) {
      logger.info('Direct HTTP unreachable, routing via WebSocket tunnel', { agent: this.agentBase });
      return wsRelay.sendCommand(this.agentBase, {
        action: path,
        ...(body || {}),
      });
    }

    throw new Error(`Sidecar ${this.agentBase} is unreachable (both HTTP and WebSocket)`);
  }

  private async acquireAndWaitForHealth(host: string): Promise<void> {
    try {
      const result = await this.sendToSidecar('/acquire', 'POST', { role: 'reranker' });

      if (result.error) {
        this.state = 'stopped';
        const err = new Error(`Reranker /acquire failed: ${result.error}`);
        logger.warn('Agent acquire failed', { error: result.error });
        throw err;
      }

      if (result.action === 'already_running') {
        logger.info('Container already running, waiting for health check...');
      } else {
        logger.info('Container started via agent, waiting for model to load...');
      }

      await this.waitForHealthy(host);
      this.state = 'ready';
      logger.info('Reranker container ready');
      // Container is up — start the heartbeat so the sidecar's idle watchdog
      // sees continuous activity and never fires the auto-stop.
      this.startHeartbeat('reranker');
    } catch (err) {
      this.state = 'stopped';
      logger.error(
        'Failed to start reranker via agent',
        err instanceof Error ? err : new Error(String(err)),
      );
      throw err;
    }
  }

  private async isHealthy(host: string): Promise<boolean> {
    try {
      const url = `${host.replace(/\/+$/, '')}/health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealthy(host: string): Promise<void> {
    const startTime = Date.now();
    const deadline = startTime + MAX_STARTUP_WAIT_MS;
    let checks = 0;

    while (Date.now() < deadline) {
      if (await this.isHealthy(host)) return;
      checks++;
      if (checks % 5 === 0) {
        logger.info(`Waiting for reranker health check... (${Math.round((Date.now() - startTime) / 1000)}s)`);
      }
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }

    throw new Error(`Reranker health check timed out after ${MAX_STARTUP_WAIT_MS / 1000}s`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Singleton instance */
export const rerankerLifecycle = new RerankerLifecycle();
