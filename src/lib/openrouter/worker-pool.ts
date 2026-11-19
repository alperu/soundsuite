/**
 * Worker pool for every direct OpenRouter call the master makes.
 *
 * One worker = one bulk OpenRouter request in flight. Bulk jobs (ingestion
 * and re-index embedding batches) wait in a FIFO queue. Interactive jobs
 * (query embeds, rerank, chat, answers) have their own small lane outside the
 * worker count, so a search never waits behind an ingestion.
 *
 * Bulk limit = min(workerCount, 429 limit, event-loop lag limit).
 *  - 429: halve the limit, back off with jitter (Retry-After when given), ramp
 *    back +1 per 15 s without a 429. A 429 is retried up to 3 times, other
 *    5xx / network errors once, 4xx never.
 *  - lag: see loop-lag.ts.
 *
 * The pool lives on `globalThis` for the same reason the spend state in
 * client.ts does: Next.js builds instrumentation and route handlers as
 * separate webpack layers, and a module-level pool would be one per layer —
 * two pools, twice the workers, and stats from the wrong one.
 *
 * Design copied from Fantom MCP (src/openrouter/workerPool.ts).
 */
import { defaultPoolSettings, POOL_LIMITS, clampWorkerCount, type PoolSettings } from './pool-settings';
import { LoopLagGuard, type LagState } from './loop-lag';

export type Lane = 'bulk' | 'interactive';

export interface JobSpec<T> {
  role: string;
  lane: Lane;
  run: () => Promise<T>;
}

interface Queued {
  role: string;
  attempts: number;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
}

export interface RoleStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  rateLimited: number;
  retried: number;
  meanMs: number;
  meanWaitMs: number;
}

export interface PoolStats {
  settings: PoolSettings;
  limits: typeof POOL_LIMITS;
  bulk: { running: number; queued: number; limit: number };
  interactive: { running: number; queued: number; limit: number };
  rateLimit: { adaptiveLimit: number; hits: number; coolingDownMs: number; state: 'steady' | 'ramping' | 'backing-off' };
  lag: LagState;
  totals: { done: number; failed: number; rateLimited: number; retried: number };
  byRole: Record<string, RoleStats>;
}

const RAMP_INTERVAL_MS = 15_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_429_RETRIES = 3;
const MAX_OTHER_RETRIES = 1;
/** Wait before retrying a 5xx / network error (plus jitter). */
const OTHER_RETRY_DELAY_MS = 400;
/** An interactive call waits out a 429 cooldown for at most this long. */
const INTERACTIVE_MAX_COOLDOWN_WAIT_MS = 3_000;

/** Status of an error from the OpenRouter client, duck-typed so this module
 *  does not import client.ts (which imports this one). */
function errStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

export function isRateLimited(err: unknown): boolean {
  return errStatus(err) === 429;
}

/** 429, 5xx and network errors (status 0) are worth another try; 4xx is not. */
export function isRetryable(err: unknown): boolean {
  const s = errStatus(err);
  if (s === undefined) return false;
  return s === 429 || s === 0 || s >= 500;
}

function retryAfterOf(err: unknown): number | undefined {
  const v = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === 'number' && v > 0 ? v : undefined;
}

export class OpenRouterWorkerPool {
  private bulkQueue: Queued[] = [];
  private bulkRunning = 0;
  private interQueue: Queued[] = [];
  private interRunning = 0;
  private settings: PoolSettings;

  private adaptive = Number.POSITIVE_INFINITY;
  private rateLimitHits = 0;
  private backoffUntil = 0;
  private backoffMs = BASE_BACKOFF_MS;
  private lastRateLimitAt = 0;
  private lastRampAt = 0;
  private wakeTimer: NodeJS.Timeout | null = null;

  private roles = new Map<string, RoleStats & { totalMs: number; totalWaitMs: number }>();
  readonly lag: LoopLagGuard;

  constructor(settings: Partial<PoolSettings> = {}, lag?: LoopLagGuard) {
    this.settings = { ...defaultPoolSettings(), ...settings };
    this.lag = lag ?? new LoopLagGuard(() => this.settings.workerCount);
  }

  /** Apply a saved worker count; takes effect on the next job start. */
  setWorkerCount(n: unknown): void {
    const next = clampWorkerCount(n);
    if (next === this.settings.workerCount) return;
    this.settings = { ...this.settings, workerCount: next };
    this.pump();
  }

  getSettings(): PoolSettings {
    return { ...this.settings };
  }

  submit<T>(spec: JobSpec<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const q: Queued = {
        role: spec.role,
        attempts: 0,
        run: spec.run as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      };
      this.role(spec.role).queued++;
      if (spec.lane === 'interactive') this.interQueue.push(q);
      else this.bulkQueue.push(q);
      this.pump();
    });
  }

  /** Bulk limit right now. */
  bulkLimit(): number {
    return Math.max(1, Math.min(this.settings.workerCount, this.adaptive, this.lag.limit()));
  }

  private pump(): void {
    const now = Date.now();
    this.rampIfClean(now);
    const cooling = this.backoffUntil > now ? this.backoffUntil - now : 0;

    // Interactive lane: own slots; waits out a short cooldown only.
    while (this.interRunning < this.settings.interactiveSlots && this.interQueue.length > 0) {
      if (cooling > 0 && now - this.interQueue[0].enqueuedAt < INTERACTIVE_MAX_COOLDOWN_WAIT_MS) break;
      this.start(this.interQueue.shift()!, 'interactive');
    }

    if (cooling === 0) {
      while (this.bulkRunning < this.bulkLimit() && this.bulkQueue.length > 0) {
        this.start(this.bulkQueue.shift()!, 'bulk');
      }
    }

    if (cooling > 0 && (this.bulkQueue.length > 0 || this.interQueue.length > 0) && !this.wakeTimer) {
      const wait = Math.min(cooling, this.interQueue.length > 0 ? INTERACTIVE_MAX_COOLDOWN_WAIT_MS : cooling);
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.pump();
      }, Math.max(10, wait));
      this.wakeTimer.unref?.();
    }
  }

  private start(job: Queued, lane: Lane): void {
    const rs = this.role(job.role);
    rs.queued = Math.max(0, rs.queued - 1);
    rs.running++;
    if (lane === 'bulk') this.bulkRunning++;
    else this.interRunning++;
    const t0 = Date.now();
    if (job.attempts === 0) rs.totalWaitMs += t0 - job.enqueuedAt;
    job.attempts++;
    void (async () => {
      let requeueAfterMs: number | null = null;
      try {
        const out = await job.run();
        rs.done++;
        rs.totalMs += Date.now() - t0;
        job.resolve(out);
      } catch (err) {
        const limited = isRateLimited(err);
        if (limited) {
          rs.rateLimited++;
          this.noteRateLimited(retryAfterOf(err));
        }
        const maxRetries = limited ? MAX_429_RETRIES : MAX_OTHER_RETRIES;
        if (isRetryable(err) && job.attempts <= maxRetries) {
          rs.retried++;
          rs.queued++;
          // A 429 waits on the pool's cooldown; other errors wait a moment
          // with jitter so retries do not land in lockstep.
          requeueAfterMs = limited ? 0 : OTHER_RETRY_DELAY_MS + Math.floor(Math.random() * 200);
        } else {
          rs.failed++;
          job.reject(err);
        }
      } finally {
        rs.running = Math.max(0, rs.running - 1);
        if (lane === 'bulk') this.bulkRunning--;
        else this.interRunning--;
        if (requeueAfterMs !== null) {
          const requeue = () => {
            if (lane === 'bulk') this.bulkQueue.unshift(job);
            else this.interQueue.unshift(job);
            this.pump();
          };
          if (requeueAfterMs > 0) setTimeout(requeue, requeueAfterMs);
          else requeue();
        }
        this.pump();
      }
    })();
  }

  noteRateLimited(retryAfterMs?: number, now = Date.now()): void {
    this.rateLimitHits++;
    const current = Math.min(this.adaptive, this.settings.workerCount, Math.max(1, this.bulkRunning));
    this.adaptive = Math.max(1, Math.floor(current / 2));
    const base = retryAfterMs && retryAfterMs > 0 ? Math.min(MAX_BACKOFF_MS, retryAfterMs) : this.backoffMs;
    this.backoffUntil = now + base / 2 + (Math.random() * base) / 2;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.lastRateLimitAt = now;
    this.lastRampAt = now;
  }

  private rampIfClean(now: number): void {
    if (!Number.isFinite(this.adaptive)) return;
    if (now - this.lastRateLimitAt < RAMP_INTERVAL_MS || now - this.lastRampAt < RAMP_INTERVAL_MS) return;
    this.lastRampAt = now;
    this.backoffMs = BASE_BACKOFF_MS;
    if (this.adaptive + 1 >= this.settings.workerCount) this.adaptive = Number.POSITIVE_INFINITY;
    else this.adaptive += 1;
  }

  private role(name: string) {
    let r = this.roles.get(name);
    if (!r) {
      r = { queued: 0, running: 0, done: 0, failed: 0, rateLimited: 0, retried: 0, meanMs: 0, meanWaitMs: 0, totalMs: 0, totalWaitMs: 0 };
      this.roles.set(name, r);
    }
    return r;
  }

  stats(now = Date.now()): PoolStats {
    const s = this.settings;
    const byRole: Record<string, RoleStats> = {};
    const totals = { done: 0, failed: 0, rateLimited: 0, retried: 0 };
    for (const [k, r] of this.roles) {
      const { totalMs, totalWaitMs, ...rest } = r;
      const finished = r.done + r.failed;
      byRole[k] = {
        ...rest,
        meanMs: r.done ? Math.round(totalMs / r.done) : 0,
        meanWaitMs: finished ? Math.round(totalWaitMs / finished) : 0,
      };
      totals.done += r.done;
      totals.failed += r.failed;
      totals.rateLimited += r.rateLimited;
      totals.retried += r.retried;
    }
    const cooling = Math.max(0, this.backoffUntil - now);
    return {
      settings: { ...s },
      limits: POOL_LIMITS,
      bulk: { running: this.bulkRunning, queued: this.bulkQueue.length, limit: this.bulkLimit() },
      interactive: { running: this.interRunning, queued: this.interQueue.length, limit: s.interactiveSlots },
      rateLimit: {
        adaptiveLimit: Number.isFinite(this.adaptive) ? this.adaptive : s.workerCount,
        hits: this.rateLimitHits,
        coolingDownMs: cooling,
        state: cooling > 0 ? 'backing-off' : Number.isFinite(this.adaptive) ? 'ramping' : 'steady',
      },
      lag: this.lag.stats(),
      totals,
      byRole,
    };
  }
}

const poolGlobal = globalThis as unknown as { __ss_openrouter_pool__?: OpenRouterWorkerPool };

/** The process-wide pool. Starts the lag monitor on first use (not in jest). */
export function openRouterPool(): OpenRouterWorkerPool {
  let pool = poolGlobal.__ss_openrouter_pool__;
  if (!pool) {
    pool = new OpenRouterWorkerPool();
    poolGlobal.__ss_openrouter_pool__ = pool;
    if (process.env.JEST_WORKER_ID === undefined) pool.lag.start();
  }
  return pool;
}

export function openRouterPoolStats(): PoolStats {
  return openRouterPool().stats();
}

/** Test seam. */
export function __resetOpenRouterPoolForTest(p: OpenRouterWorkerPool | null = null): void {
  poolGlobal.__ss_openrouter_pool__?.lag.stop();
  poolGlobal.__ss_openrouter_pool__ = p ?? undefined;
}
