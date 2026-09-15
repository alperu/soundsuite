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
  hostOs?: 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2' | 'unknown';
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

/** Marks a host as having been seeded once, so it is never auto-seeded again. */
function seededMarkerKey(sidecarUrl: string): string {
  return `roleRegistry.seeded.${sidecarUrl.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/**
 * Seed default assignments for a single host, ONCE EVER.
 *
 * Called from `pushModelRegistry` and `pushFullConfig` so a freshly-registered
 * sidecar comes up with a sensible mode set for its OS and an operator does not
 * have to click around before containers appear.
 *
 * Why a persistent marker and not just "are there zero rows":
 *
 * Both callers run on EVERY push, and "zero rows" is also what an operator who
 * has deliberately turned every role off looks like. So the old row-count check
 * re-seeded those hosts — enabled — on the very next push, making it impossible
 * to disable a host at all. That got sharply worse once config pushes started
 * firing on settings-save and on heartbeat self-heal rather than only at
 * registration: the roles came back within seconds.
 *
 * The marker distinguishes "never configured" from "deliberately emptied",
 * which a row count cannot. It is also set for hosts that already have rows, so
 * existing fleets are grandfathered and cannot be re-seeded after being cleared.
 */
export async function seedAssignmentsForHost(
  sidecarUrl: string,
  hostOs: SidecarEntry['hostOs'],
): Promise<number> {
  const url = sidecarUrl.replace(/\/+$/, '');
  const markerKey = seededMarkerKey(url);

  const marker = await prisma.config.findUnique({ where: { key: markerKey } });
  if (marker) return 0;

  const existing = await prisma.hostRoleAssignment.count({ where: { sidecarUrl: url } });
  if (existing > 0) {
    // Already configured before markers existed — record that, so clearing its
    // roles later is respected rather than undone.
    await prisma.config.upsert({
      where: { key: markerKey },
      create: { key: markerKey, value: new Date().toISOString() },
      update: {},
    });
    return 0;
  }
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
  // Written only after a successful seed, so a failure part-way through is
  // retried on the next push rather than leaving the host half-configured and
  // permanently marked.
  await prisma.config.upsert({
    where: { key: markerKey },
    create: { key: markerKey, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
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
