/**
 * The runtime switch. One process-wide active profile (design A in
 * docs/tasks/54-profiles.md): switching changes what EVERY caller sees —
 * dashboard, MCP, the HTTP APIs — and restarts the services that hold
 * handles.
 *
 * Order matters:
 *   1. registry → the new name is the answer to "which profile" from now on;
 *   2. stop services bound to the old profile (watcher, parsing workers,
 *      scanner daemon) so nothing writes to the old database mid-switch;
 *   3. drop the per-profile clients (Prisma, Kysely, Redis prefix) and the
 *      tool registry (its VectorStore points at the old lancedb);
 *   4. start services again — they rebuild from the new profile's Case rows.
 *
 * Serialised: a second switch while one is running waits for it.
 */
import { createLogger } from '@/lib/logger';
import { activeProfileName, profilePaths, setActiveProfileName } from './registry';

const logger = createLogger('Profiles');

const g = globalThis as unknown as { __ssProfileSwitch?: Promise<unknown> };

export interface SwitchResult {
  from: string;
  to: string;
  changed: boolean;
  restarted: string[];
  warnings: string[];
}

export async function switchProfile(to: string): Promise<SwitchResult> {
  const run = async (): Promise<SwitchResult> => {
    const from = activeProfileName();
    if (from === to) return { from, to, changed: false, restarted: [], warnings: [] };

    const restarted: string[] = [];
    const warnings: string[] = [];

    // 1. Registry first: from here on, `activeProfile()` names the target.
    setActiveProfileName(to);
    const paths = profilePaths(to);
    // Legacy readers (scripts, the odd env-driven path) follow along.
    process.env.DATABASE_URL = `file:${paths.sqlite}`;
    process.env.LANCEDB_PATH = paths.lancedb;
    logger.info('Switching profile', { from, to });

    // 2. Stop what holds the old profile.
    try {
      const { stopProfileBoundServices } = await import('@/services/worker-init');
      restarted.push(...(await stopProfileBoundServices()));
    } catch (err) {
      warnings.push(`stopping services: ${(err as Error).message}`);
    }

    // 3. Drop per-profile clients and caches.
    try {
      const { releasePrismaClient } = await import('@/lib/db/prisma');
      await releasePrismaClient(from);
    } catch (err) {
      warnings.push(`prisma: ${(err as Error).message}`);
    }
    try {
      const { releaseKysely } = await import('@/lib/legal/kysely');
      releaseKysely(from);
    } catch (err) {
      warnings.push(`kysely: ${(err as Error).message}`);
    }
    try {
      const { disconnectRedis } = await import('@/lib/redis');
      await disconnectRedis();
    } catch (err) {
      warnings.push(`redis: ${(err as Error).message}`);
    }
    try {
      const { resetToolRegistry } = await import('@/lib/mcp/get-tool-registry');
      resetToolRegistry();
    } catch (err) {
      warnings.push(`tool registry: ${(err as Error).message}`);
    }

    // 4. Start again against the new profile.
    try {
      const { startProfileBoundServices } = await import('@/services/worker-init');
      await startProfileBoundServices();
    } catch (err) {
      warnings.push(`starting services: ${(err as Error).message}`);
    }

    logger.info('Profile switched', { from, to, restarted, warnings: warnings.length });
    return { from, to, changed: true, restarted, warnings };
  };

  const prev = g.__ssProfileSwitch ?? Promise.resolve();
  const next = prev.then(run, run);
  g.__ssProfileSwitch = next.catch(() => undefined);
  return next;
}
