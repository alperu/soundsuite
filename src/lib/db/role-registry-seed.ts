/**
 * Role Registry — first-run seed (simplified catalog).
 *
 * On boot, for every sidecar registered in `gpu.sidecars` that has zero
 * HostRoleAssignment rows, seed a default set of enabled modes. Idempotent
 * per sidecar: only writes when the sidecar has no rows yet.
 *
 * Default modes per OS:
 *   - linux:        ss-embedding, ss-completion, ss-ocr, ss-reranker
 *   - darwin:       ss-embedding, ss-completion, ss-ocr  (no reranker)
 *   - win32:        same as darwin (WSL2+NVIDIA detection is out of scope)
 *   - unknown:      same as darwin (conservative)
 *
 * The seed cannot reach the sidecar's OS directly — it uses any cached
 * `hostOs` field from the gpuSidecars config. When unknown, falls back to
 * the conservative darwin set.
 */

import { prisma } from './prisma';
import { getConfig } from './config';
import { createLogger } from '@/lib/logger';

const log = createLogger('role-registry-seed');

interface SidecarEntry {
  url: string;
  hostOs?: 'linux' | 'darwin' | 'win32' | 'unknown';
}

const COMMON_MODES = ['ss-embedding', 'ss-completion', 'ss-ocr'] as const;
const RERANKER = 'ss-reranker' as const;

const DEFAULT_MIN_ONLINE: Record<string, number> = {
  'ss-embedding': 1,
  'ss-completion': 1,
  'ss-ocr': 1,
  'ss-reranker': 1,
};
const DEFAULT_IDLE_MIN: Record<string, number> = {
  'ss-embedding': 0,
  'ss-completion': 10,
  'ss-ocr': 5,
  'ss-reranker': 5,
};

function modesForOs(os: SidecarEntry['hostOs']): string[] {
  if (os === 'linux') return [...COMMON_MODES, RERANKER];
  return [...COMMON_MODES];
}

/**
 * Seed default assignments for a single host on demand. Idempotent: a no-op
 * when the host already has at least one HostRoleAssignment row.
 *
 * Used by fleet-router.pushModelRegistry so the first config push for a
 * freshly-registered sidecar populates the expected mode set based on its
 * detected OS — operators do not have to click around the admin UI before
 * a sidecar's containers appear.
 */
export async function seedAssignmentsForHost(
  sidecarUrl: string,
  hostOs: SidecarEntry['hostOs'],
): Promise<number> {
  const url = sidecarUrl.replace(/\/+$/, '');
  const existing = await prisma.hostRoleAssignment.count({ where: { sidecarUrl: url } });
  if (existing > 0) return 0;
  const modes = modesForOs(hostOs);
  log.info(
    `Seeding ${modes.length} default assignments for ${url} on demand (hostOs=${hostOs ?? 'unknown'})`,
  );
  for (const mode of modes) {
    await prisma.hostRoleAssignment.create({
      data: {
        sidecarUrl: url,
        mode,
        enabled: true,
        minOnline: DEFAULT_MIN_ONLINE[mode] ?? 0,
        idleTimeoutMin: DEFAULT_IDLE_MIN[mode] ?? 5,
        modelOverride: null,
      },
    });
  }
  return modes.length;
}

export async function seedRoleRegistry(): Promise<void> {
  try {
    let sidecars: SidecarEntry[] = [];
    try {
      const cfg = await getConfig();
      const list = JSON.parse(cfg.gpuSidecars || '[]') as SidecarEntry[];
      sidecars = list.filter(s => s.url);
    } catch {
      sidecars = [];
    }

    if (sidecars.length === 0) {
      log.info('No registered sidecars yet — skipping HostRoleAssignment seed');
      return;
    }

    for (const sc of sidecars) {
      const url = sc.url.replace(/\/+$/, '');
      const existing = await prisma.hostRoleAssignment.count({
        where: { sidecarUrl: url },
      });
      if (existing > 0) continue;

      const modes = modesForOs(sc.hostOs);
      log.info(
        `Seeding ${modes.length} default assignments for ${url} (hostOs=${sc.hostOs ?? 'unknown'})`,
      );
      for (const mode of modes) {
        await prisma.hostRoleAssignment.create({
          data: {
            sidecarUrl: url,
            mode,
            enabled: true,
            minOnline: DEFAULT_MIN_ONLINE[mode] ?? 0,
            idleTimeoutMin: DEFAULT_IDLE_MIN[mode] ?? 5,
            modelOverride: null,
          },
        });
      }
    }
  } catch (err) {
    log.error(`Role registry seed failed: ${(err as Error).message}`);
  }
}
