/**
 * Stale JobLog reaper.
 *
 * The ingestion pipeline creates a JobLog row when it starts and closes it
 * (completedAt + counters) when it finishes — success or failure. If the
 * worker process crashes or the dev server restarts mid-run, the JobLog
 * row stays open forever. The admin UI counts open JobLog rows as "active
 * processing", so orphans make the top header lie about real state.
 *
 * This reaper closes any JobLog where:
 *   completedAt IS NULL AND startedAt < now() - STALE_THRESHOLD_MS
 *
 * Closed rows are marked failed with a synthetic errorSummary so they're
 * distinguishable from real failures. Runs once on startup and then every
 * REAP_INTERVAL_MS.
 *
 * Threshold = 30 min. The longest legitimate run we've observed (multi-pass
 * deep-search synthesis + rerank) is ~10 min, so 30 min is a comfortable
 * upper bound that won't false-positive a slow real job.
 */

import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logger';

const logger = createLogger('JobLogReaper');

export const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min
const REAP_INTERVAL_MS = 5 * 60 * 1000;           // 5 min

const REAPED_ERROR_SUMMARY =
  'Reaped: job exceeded stale threshold, presumed orphaned (worker restart or crash).';

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

/**
 * Close any JobLog rows that have been open longer than `thresholdMs`.
 * Returns the count of reaped rows. Safe to call concurrently — the second
 * caller is a no-op.
 */
export async function reapStaleJobLogs(thresholdMs: number = STALE_THRESHOLD_MS): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const cutoff = new Date(Date.now() - thresholdMs);
    const stale = await prisma.jobLog.findMany({
      where: { completedAt: null, startedAt: { lt: cutoff } },
      select: { id: true, documentsQueued: true, documentsProcessed: true },
    });
    if (stale.length === 0) return 0;

    const now = new Date();
    // updateMany would be one round-trip but Prisma's updateMany can't
    // compute per-row values. The orphan set is small (typically < 10),
    // so loop is fine and lets us preserve documentsProcessed counters.
    await Promise.all(stale.map(j => prisma.jobLog.update({
      where: { id: j.id },
      data: {
        completedAt: now,
        // Anything still "queued but not processed" is treated as failed.
        documentsFailed: Math.max(0, j.documentsQueued - j.documentsProcessed),
        errorSummary: REAPED_ERROR_SUMMARY,
      },
    })));

    logger.info(`Reaped ${stale.length} stale JobLog row(s)`, {
      count: stale.length,
      thresholdMin: Math.round(thresholdMs / 60000),
    });
    return stale.length;
  } catch (err) {
    logger.error('JobLog reap failed', err);
    return 0;
  } finally {
    running = false;
  }
}

/** Start the periodic reaper. Runs once immediately, then every 5 min. */
export function startJobLogReaper(): void {
  if (intervalHandle) return;
  // Fire once at startup to clean up anything left over from prior runs.
  void reapStaleJobLogs();
  intervalHandle = setInterval(() => void reapStaleJobLogs(), REAP_INTERVAL_MS);
  // Don't keep the Node event loop alive just for the reaper.
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('JobLog reaper started', {
    intervalMin: REAP_INTERVAL_MS / 60000,
    thresholdMin: STALE_THRESHOLD_MS / 60000,
  });
}

/** Stop the reaper. Used by tests. */
export function stopJobLogReaper(): void {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}
