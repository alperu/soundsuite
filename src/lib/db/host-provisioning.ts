/**
 * HostProvisioning DAO — per-sidecar overrides for OS detection and the
 * master URL THIS host should use to call HOME.
 *
 * NULL / undefined fields mean "fall back to the global default" (env var,
 * Config DB key, or derived-from-request — see master-identity.ts).
 */

import { prisma } from './prisma';

export type HostOsOverride = 'darwin' | 'win32' | 'linux';

export interface HostProvisioningRecord {
  sidecarUrl: string;
  hostOsOverride: HostOsOverride | null;
  masterUrlForHost: string | null;
  notes: string | null;
}

/** Strip trailing slashes + whitespace. Empty input → empty string. */
export function normalizeSidecarUrl(u: string): string {
  return (u || '').trim().replace(/\/+$/, '');
}

/** Same normalization used for stored master URLs. */
export function normalizeMasterUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  const trimmed = u.trim().replace(/\/+$/, '');
  return trimmed || null;
}

export function isValidHostOs(v: unknown): v is HostOsOverride {
  return v === 'darwin' || v === 'win32' || v === 'linux';
}

function toRecord(row: {
  sidecarUrl: string;
  hostOsOverride: string | null;
  masterUrlForHost: string | null;
  notes: string | null;
}): HostProvisioningRecord {
  return {
    sidecarUrl: row.sidecarUrl,
    hostOsOverride: isValidHostOs(row.hostOsOverride) ? row.hostOsOverride : null,
    masterUrlForHost: row.masterUrlForHost,
    notes: row.notes,
  };
}

export async function getProvisioning(
  sidecarUrl: string,
): Promise<HostProvisioningRecord | null> {
  const key = normalizeSidecarUrl(sidecarUrl);
  if (!key) return null;
  const row = await prisma.hostProvisioning.findUnique({ where: { sidecarUrl: key } });
  return row ? toRecord(row) : null;
}

export async function listProvisioning(): Promise<HostProvisioningRecord[]> {
  const rows = await prisma.hostProvisioning.findMany({ orderBy: { sidecarUrl: 'asc' } });
  return rows.map(toRecord);
}

export async function upsertProvisioning(
  input: HostProvisioningRecord,
): Promise<HostProvisioningRecord> {
  const key = normalizeSidecarUrl(input.sidecarUrl);
  if (!key) throw new Error('sidecarUrl is required');
  const hostOsOverride = isValidHostOs(input.hostOsOverride) ? input.hostOsOverride : null;
  const masterUrlForHost = normalizeMasterUrl(input.masterUrlForHost);
  const notes = input.notes && input.notes.trim() ? input.notes : null;

  const row = await prisma.hostProvisioning.upsert({
    where: { sidecarUrl: key },
    create: {
      sidecarUrl: key,
      hostOsOverride,
      masterUrlForHost,
      notes,
    },
    update: {
      hostOsOverride,
      masterUrlForHost,
      notes,
    },
  });
  return toRecord(row);
}

export async function deleteProvisioning(sidecarUrl: string): Promise<void> {
  const key = normalizeSidecarUrl(sidecarUrl);
  if (!key) return;
  await prisma.hostProvisioning.deleteMany({ where: { sidecarUrl: key } });
}
