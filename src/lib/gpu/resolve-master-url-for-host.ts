/**
 * Resolve the master URL THIS sidecar should call HOME to.
 *
 * Fallback chain:
 *   1. HostProvisioning.masterUrlForHost (per-sidecar override from /admin/host-provisioning)
 *   2. SOUND_SUITE_MASTER_URL env
 *   3. Config DB key `master.url` (settable from /admin)
 *   4. Derived-from-recent-request cache (Host header on inbound HTTP hits)
 *
 * Returns null when nothing is known.
 */

import { getProvisioning } from '@/lib/db/host-provisioning';
import { getCanonicalMasterUrl } from '@/lib/gpu/master-identity';

export async function resolveMasterUrlForHost(
  sidecarUrl: string | null | undefined,
): Promise<string | null> {
  if (sidecarUrl) {
    try {
      const prov = await getProvisioning(sidecarUrl);
      if (prov?.masterUrlForHost) return prov.masterUrlForHost;
    } catch {
      // fall through to global
    }
  }
  return getCanonicalMasterUrl();
}
