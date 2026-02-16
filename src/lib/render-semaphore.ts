/**
 * PID-aware concurrency limiter for server-side PDF page rendering.
 *
 * Reads the UI worker count from WorkerPoolService to set max concurrent renders.
 * Records each render as a UI request via recordRequestTime() for PID demand tracking.
 * Falls back to fixed concurrency when Redis is unavailable.
 */

import { createLogger } from './logger';

const logger = createLogger('RenderSemaphore');

const DEFAULT_CONCURRENCY = 4;
const REFRESH_INTERVAL_MS = 2000;

let maxConcurrency = DEFAULT_CONCURRENCY;
let activeConcurrency = 0;
let lastRefresh = 0;
const waitQueue: Array<() => void> = [];

/**
 * Refresh the max concurrency from the PID controller.
 * Cached for REFRESH_INTERVAL_MS to avoid hammering Redis.
 */
async function refreshConcurrency(): Promise<void> {
  const now = Date.now();
  if (now - lastRefresh < REFRESH_INTERVAL_MS) return;
  lastRefresh = now;

  try {
    const { isRedisAvailable } = await import('./redis');
    if (!(await isRedisAvailable())) {
      maxConcurrency = DEFAULT_CONCURRENCY;
      return;
    }

    const { WorkerPoolService } = await import('@/services/worker-pool-service');
    const pool = await WorkerPoolService.fromConfig();
    const uiWorkers = await pool.getUiWorkerCount();
    maxConcurrency = Math.max(2, uiWorkers);
  } catch {
    maxConcurrency = DEFAULT_CONCURRENCY;
  }
}

/**
 * Record that a UI request was served (for PID demand tracking).
 */
async function recordRequest(): Promise<void> {
  try {
    const { isRedisAvailable } = await import('./redis');
    if (!(await isRedisAvailable())) return;

    const { WorkerPoolService } = await import('@/services/worker-pool-service');
    const pool = await WorkerPoolService.fromConfig();
    await pool.recordRequestTime();
  } catch {
    // Silently ignore — PID tracking is best-effort
  }
}

/**
 * Acquire a render slot. Resolves when a slot is available.
 */
export async function acquire(): Promise<void> {
  await refreshConcurrency();

  if (activeConcurrency < maxConcurrency) {
    activeConcurrency++;
    return;
  }

  // Wait for a slot
  return new Promise<void>(resolve => {
    waitQueue.push(() => {
      activeConcurrency++;
      resolve();
    });
  });
}

/**
 * Release a render slot and record the request for PID metrics.
 */
export async function release(): Promise<void> {
  activeConcurrency--;

  // Wake up the next waiter
  if (waitQueue.length > 0 && activeConcurrency < maxConcurrency) {
    const next = waitQueue.shift();
    next?.();
  }

  // Fire-and-forget PID tracking
  recordRequest().catch(() => {});
}

/**
 * Run a function with the semaphore held.
 */
export async function withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Get current concurrency stats (for debugging/monitoring).
 */
export function getStats(): { active: number; max: number; queued: number } {
  return { active: activeConcurrency, max: maxConcurrency, queued: waitQueue.length };
}
