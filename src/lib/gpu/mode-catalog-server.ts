/**
 * Mode catalog — server-only async resolvers.
 *
 * These functions read the Config table (Prisma) and therefore CANNOT be
 * imported from client components — webpack will try to bundle better-sqlite3
 * into the client chunk and fail (`Module not found: Can't resolve 'fs'`).
 *
 * Client code uses the pure metadata in `./mode-catalog` plus
 * `/api/admin/mode-catalog` for live default-model values.
 */

import 'server-only';

import { getConfig } from '@/lib/db/config';
import {
  MODE_METADATA,
  resolveModelFromConfig,
  type HostOs,
  type ModeCatalogEntry,
  type ModeName,
} from './mode-catalog';

function buildDefaultModelMap(
  m: { availableOn: HostOs[] },
  model: string,
): Partial<Record<HostOs, string>> {
  const out: Partial<Record<HostOs, string>> = {};
  for (const os of m.availableOn) out[os] = model;
  return out;
}

/**
 * Async catalog view. Reads Config once and folds the operator-set model
 * into every entry's `defaultModel` map. Single DB round-trip.
 */
export async function getModeCatalog(): Promise<ModeCatalogEntry[]> {
  const cfg = await getConfig();
  return MODE_METADATA.map((m) => ({
    ...m,
    defaultModel: buildDefaultModelMap(m, resolveModelFromConfig(m.name, cfg)),
  }));
}

/**
 * Async single-mode resolver — what the master should push as the
 * effective model for a given mode+OS when no per-host modelOverride is set.
 * Returns null when the mode is unavailable on this OS.
 */
export async function defaultModelForAsync(
  mode: ModeName,
  hostOs: HostOs,
): Promise<string | null> {
  const entry = MODE_METADATA.find((m) => m.name === mode);
  if (!entry || !entry.availableOn.includes(hostOs)) return null;
  const cfg = await getConfig();
  return resolveModelFromConfig(mode, cfg);
}
