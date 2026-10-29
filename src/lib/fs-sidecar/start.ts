/**
 * Start the fileSystemSideCar link from env (called by worker-init).
 *
 *   FS_SIDECAR_USERS  JSON {"username": "password or scrypt$salt$hash"}; unset = off
 *   FS_SIDECAR_PORT   listen port (default 8791)
 *   FS_SIDECAR_HOST   bind address (default 0.0.0.0)
 *   FS_SIDECAR_ROOTS  JSON {"rootName": "/local/base/path"} to link folders to cases
 */
import type { FsLinkServer } from './server';

const g = globalThis as unknown as { __ss_fs_link__?: Promise<FsLinkServer | null> };

export function fsSidecarUsersFromEnv(env = process.env): Record<string, string> {
  try {
    const v = JSON.parse(env.FS_SIDECAR_USERS || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function startFsSidecarLinkFromEnv(
  log: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void,
  version?: string,
): Promise<FsLinkServer | null> {
  if (g.__ss_fs_link__) return g.__ss_fs_link__;
  const credentials = fsSidecarUsersFromEnv();
  if (!Object.keys(credentials).length) return Promise.resolve(null);
  g.__ss_fs_link__ = (async () => {
    const { startFsSidecarLink } = await import('./server');
    const { PrismaFolderStatStore, rootsFromEnv } = await import('./folder-store');
    const { prisma } = await import('@/lib/db/prisma');
    const store = new PrismaFolderStatStore(prisma as never, rootsFromEnv());
    return startFsSidecarLink({
      port: Number(process.env.FS_SIDECAR_PORT || 8791),
      host: process.env.FS_SIDECAR_HOST || '0.0.0.0',
      credentials,
      store,
      serverVersion: version,
      log,
    });
  })();
  return g.__ss_fs_link__;
}
