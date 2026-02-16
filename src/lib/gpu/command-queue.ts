/**
 * Sidecar Command Queue — Gossip Protocol Foundation
 *
 * Replaces direct HTTP push (`sendToSidecar`) with a queue-based model:
 *   1. Try WebSocket tunnel first (instant, if sidecar has active WS)
 *   2. Fall back to queuing command in DB for sidecar to poll
 *
 * Sidecars poll `/api/admin/gpu/sidecars/poll` to pick up pending commands,
 * then report results via `/api/admin/gpu/sidecars/result`.
 */

import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logger';
import * as wsRelay from '@/lib/gpu/ws-relay';
import { SidecarError } from '@/lib/gpu/sidecar-error';

const logger = createLogger('CommandQueue');

// In-memory waiters: commandId → { resolve, reject, timer }
const waiters = new Map<string, {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/**
 * Queue a command to a sidecar. Tries WS first, falls back to DB queue.
 * Returns a promise that resolves when the sidecar reports the result.
 */
export async function queueSidecarCommand(
  agentUrl: string,
  action: string,
  payload?: object,
  timeoutMs = 30_000,
): Promise<any> {
  const normalized = agentUrl.replace(/\/+$/, '');
  const startTime = Date.now();

  // 1. Try WebSocket tunnel (instant if connected)
  const hasWs = wsRelay.hasSidecarConnection(normalized);
  logger.info(`Command → ${action}`, {
    target: normalized,
    transport: hasWs ? 'WS' : 'HTTP-queue',
    timeoutMs,
  });

  if (hasWs) {
    try {
      const result = await wsRelay.sendCommand(normalized, {
        action: `/${action.replace(/^\//, '')}`,
        ...(payload || {}),
      }, timeoutMs);
      const elapsed = Date.now() - startTime;
      logger.info(`Command ✓ ${action}`, { transport: 'WS', elapsed: `${elapsed}ms` });
      return result;
    } catch (err) {
      // If the sidecar responded (business error), don't fall back to HTTP —
      // the WS transport worked fine, the sidecar just said "no".
      if (err instanceof SidecarError) {
        const elapsed = Date.now() - startTime;
        logger.warn(`WS command rejected by sidecar for ${normalized} after ${elapsed}ms (no HTTP fallback)`, {
          action,
          error: err.message,
        });
        throw err;
      }
      const elapsed = Date.now() - startTime;
      logger.warn(`WS transport failed for ${normalized} after ${elapsed}ms, falling back to HTTP queue`, {
        action,
        error: (err as Error).message,
      });
    }
  }

  // 2. Queue in DB for HTTP poll pickup
  const cmd = await prisma.sidecarCommand.create({
    data: {
      sidecarUrl: normalized,
      action,
      payload: JSON.stringify(payload || {}),
      status: 'pending',
      expiresAt: new Date(Date.now() + timeoutMs),
    },
  });

  logger.info(`Command queued (HTTP fallback)`, { id: cmd.id, action, target: normalized });

  // 3. Wait for result
  return waitForResult(cmd.id, timeoutMs);
}

/**
 * Wait for a sidecar to report a command result.
 * Resolves when `reportCommandResult()` is called with matching commandId.
 */
function waitForResult(commandId: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      waiters.delete(commandId);
      // Mark as expired in DB
      try {
        await prisma.sidecarCommand.update({
          where: { id: commandId },
          data: { status: 'expired' },
        });
      } catch { /* best effort */ }
      reject(new Error(`Command ${commandId} timed out after ${timeoutMs}ms (sidecar did not poll in time)`));
    }, timeoutMs);

    waiters.set(commandId, { resolve, reject, timer });
  });
}

/**
 * Called when a sidecar reports a command result (via POST /result).
 * Resolves the waiting promise.
 */
export async function reportCommandResult(
  commandId: string,
  result: any,
  error?: string,
): Promise<boolean> {
  // Update DB
  const cmd = await prisma.sidecarCommand.update({
    where: { id: commandId },
    data: {
      status: error ? 'failed' : 'completed',
      result: JSON.stringify(error ? { error } : result),
    },
  });

  const age = Date.now() - cmd.createdAt.getTime();

  // Resolve waiter
  const waiter = waiters.get(commandId);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiters.delete(commandId);
    logger.info(`Command result received (HTTP)`, {
      id: commandId,
      action: cmd.action,
      roundTrip: `${age}ms`,
      status: error ? 'failed' : 'ok',
    });
    if (error) {
      waiter.reject(new Error(error));
    } else {
      waiter.resolve(result);
    }
    return true;
  }

  // No waiter (maybe timed out already, or fire-and-forget)
  logger.warn(`Command result received but no waiter`, {
    id: commandId,
    action: cmd.action,
    age: `${age}ms`,
    waitersCount: waiters.size,
  });
  return false;
}

/**
 * Fetch pending commands for a sidecar (called by poll endpoint).
 * Marks returned commands as "dispatched".
 */
export async function fetchPendingCommands(sidecarUrl: string): Promise<Array<{
  id: string;
  action: string;
  payload: any;
}>> {
  const normalized = sidecarUrl.replace(/\/+$/, '');
  const now = new Date();

  // Get pending, non-expired commands for this sidecar
  const commands = await prisma.sidecarCommand.findMany({
    where: {
      sidecarUrl: normalized,
      status: 'pending',
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });

  if (commands.length === 0) return [];

  // Mark as dispatched
  await prisma.sidecarCommand.updateMany({
    where: { id: { in: commands.map(c => c.id) } },
    data: { status: 'dispatched' },
  });

  return commands.map(c => ({
    id: c.id,
    action: c.action,
    payload: JSON.parse(c.payload),
  }));
}

/**
 * Clean up expired/old commands. Call periodically.
 */
export async function cleanupExpiredCommands(): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
  const { count } = await prisma.sidecarCommand.deleteMany({
    where: {
      OR: [
        { status: 'expired' },
        { status: 'completed', updatedAt: { lt: cutoff } },
        { status: 'failed', updatedAt: { lt: cutoff } },
        { status: 'pending', expiresAt: { lt: new Date() } },
      ],
    },
  });
  if (count > 0) {
    logger.info(`Cleaned up ${count} expired/old commands`);
  }
  return count;
}

// Start cleanup interval (every 60s)
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanupLoop(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    cleanupExpiredCommands().catch(err =>
      logger.warn('Command cleanup failed', { error: (err as Error).message })
    );
  }, 60_000);
}

export function stopCleanupLoop(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
