/**
 * HostProvisioning DAO — per-sidecar overrides for OS detection, the master
 * URL THIS host should use to call HOME, and the WebSocket port it should
 * use to connect to that master.
 *
 * Per-host ONLY: when `masterUrlForHost` is null, the master DOES NOT push
 * any identity to this sidecar — there is no global fallback. Operator must
 * explicitly assign one on /admin/host-provisioning.
 */

import { prisma } from './prisma';

export type HostOsOverride = 'mac-docker-ollama' | 'windows-docker-wsl2' | 'linux';

export interface HostProvisioningRecord {
  sidecarUrl: string;
  hostOsOverride: HostOsOverride | null;
  masterUrlForHost: string | null;
  masterWsPortForHost: number | null;
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
  return v === 'mac-docker-ollama' || v === 'windows-docker-wsl2' || v === 'linux';
}

export function isValidWsPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536;
}

function toRecord(row: {
  sidecarUrl: string;
  hostOsOverride: string | null;
  masterUrlForHost: string | null;
  masterWsPortForHost: number | null;
  notes: string | null;
}): HostProvisioningRecord {
  return {
    sidecarUrl: row.sidecarUrl,
    hostOsOverride: isValidHostOs(row.hostOsOverride) ? row.hostOsOverride : null,
    masterUrlForHost: row.masterUrlForHost,
    masterWsPortForHost: isValidWsPort(row.masterWsPortForHost) ? row.masterWsPortForHost : null,
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
  const masterWsPortForHost = isValidWsPort(input.masterWsPortForHost) ? input.masterWsPortForHost : null;
  const notes = input.notes && input.notes.trim() ? input.notes : null;

  const row = await prisma.hostProvisioning.upsert({
    where: { sidecarUrl: key },
    create: {
      sidecarUrl: key,
      hostOsOverride,
      masterUrlForHost,
      masterWsPortForHost,
      notes,
    },
    update: {
      hostOsOverride,
      masterUrlForHost,
      masterWsPortForHost,
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
