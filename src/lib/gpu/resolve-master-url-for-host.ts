/**
 * Resolve the master URL + WS port THIS sidecar should call HOME to.
 *
 * Per-host ONLY — no global fallback. Operator must explicitly assign a
 * master URL per host on /admin/host-provisioning. When no per-host record
 * exists, returns null and callers MUST NOT push anything to the sidecar
 * (sidecar keeps using whatever URL it already has, typically the one it
 * was registered with).
 */

import { getProvisioning } from '@/lib/db/host-provisioning';

export async function resolveMasterUrlForHost(
  sidecarUrl: string | null | undefined,
): Promise<string | null> {
  if (!sidecarUrl) return null;
  try {
    const prov = await getProvisioning(sidecarUrl);
    return prov?.masterUrlForHost ?? null;
  } catch {
    return null;
  }
}

export async function resolveMasterEndpointForHost(
  sidecarUrl: string | null | undefined,
): Promise<{ url: string; wsPort: number | null } | null> {
  if (!sidecarUrl) return null;
  try {
    const prov = await getProvisioning(sidecarUrl);
    if (!prov?.masterUrlForHost) return null;
    return {
      url: prov.masterUrlForHost,
      wsPort: prov.masterWsPortForHost ?? null,
    };
  } catch {
    return null;
  }
}
