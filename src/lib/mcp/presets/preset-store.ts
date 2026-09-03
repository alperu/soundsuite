/**
 * Persistence for presets over the existing `SearchPreset` table (work item 7).
 *
 * MCP always writes `version: 2` blobs. The dashboard keeps writing v1; both
 * are readable here because `readPreset` upgrades on the fly.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../../db/prisma';
import type { PresetV2 } from '../research-types';
import { readPreset } from './preset-schema';

export interface StoredPreset {
  id: string;
  name: string;
  preset: PresetV2;
  /** Stored `version` column (1 = dashboard blob, 2 = MCP). */
  storedVersion: number;
  updatedAt: string;
}

type Row = { id: string; name: string; version: number; settings: unknown; updatedAt: Date };

function toStored(row: Row): StoredPreset | null {
  try {
    return {
      id: row.id,
      name: row.name,
      preset: readPreset(row),
      storedVersion: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch {
    // A malformed v2 row is skipped from listings rather than breaking them.
    return null;
  }
}

export async function listPresets(): Promise<StoredPreset[]> {
  const rows = (await prisma.searchPreset.findMany({ orderBy: { createdAt: 'asc' } })) as Row[];
  return rows.map(toStored).filter((p): p is StoredPreset => p !== null);
}

/** Look up by id first, then by exact name (case-insensitive fallback). */
export async function getPreset(idOrName: string): Promise<StoredPreset | null> {
  const key = idOrName.trim();
  if (!key) return null;
  const byId = (await prisma.searchPreset.findUnique({ where: { id: key } })) as Row | null;
  if (byId) return toStored(byId);
  const byName = (await prisma.searchPreset.findFirst({ where: { name: key } })) as Row | null;
  if (byName) return toStored(byName);
  const all = (await prisma.searchPreset.findMany()) as Row[];
  const ci = all.find((r) => r.name.toLowerCase() === key.toLowerCase());
  return ci ? toStored(ci) : null;
}

/** Upsert a v2 preset. Without `id` a new row is created. */
export async function savePreset(preset: PresetV2, id?: string): Promise<StoredPreset> {
  const rowId = id ?? randomUUID();
  const data = { name: preset.name, version: 2, settings: preset as unknown as object };
  const row = (await prisma.searchPreset.upsert({
    where: { id: rowId },
    create: { id: rowId, ...data },
    update: data,
  })) as Row;
  return { id: row.id, name: row.name, preset, storedVersion: 2, updatedAt: row.updatedAt.toISOString() };
}

export async function deletePreset(id: string): Promise<boolean> {
  const deleted = await prisma.searchPreset.delete({ where: { id } }).catch(() => null);
  return deleted !== null;
}
