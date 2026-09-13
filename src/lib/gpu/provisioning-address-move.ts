/**
 * Move a host's provisioning row when its advertised address changes.
 *
 * Two callers move the same row and must not drift apart:
 *
 *   1. `PATCH /api/admin/host-provisioning` — the operator correcting an address
 *      by hand (`src/app/api/admin/host-provisioning/route.ts`).
 *   2. The WS register handler in `src/lib/gpu/ws-relay.ts`, when a sidecar
 *      re-registers on its live socket under a new address. That path is
 *      currently an inline copy of this logic and is MISSING the occupied-
 *      destination check — see the header note in `docs/tasks/43-…` for the
 *      exact call site it should use instead.
 *
 * `HostProvisioning` is keyed by `sidecarUrl`, so "the host moved" means "the
 * row must be re-keyed". A blind `upsert` onto the new key silently eats
 * whatever row already sat there — that row carries another host's OS pin and
 * per-host master URL, and losing it stops the master pushing identity to a
 * host that was working fine. So an occupied destination is a NAMED CONFLICT,
 * the same rule `rekeySidecarAddress()` already follows for the live registry.
 *
 * Properties the WS caller depends on:
 *
 * - **Never throws.** A database problem must not stop a sidecar registering,
 *   so every failure comes back as `{ status: 'error' }` for the caller to log.
 * - **Idempotent and write-free when there is nothing to do.** Task 42 found a
 *   sidecar reconnecting roughly once per second on at least one host; if this
 *   ran on every register it must not mean a database write per second. It
 *   issues writes ONLY when a row actually exists at `from` and the address
 *   really changed. The steady state after a successful move — a row at `to`,
 *   none at `from` — returns `no-row` having written nothing.
 */

import {
  HostProvisioningRecord,
  deleteProvisioning,
  getProvisioning,
  normalizeSidecarUrl,
  upsertProvisioning,
} from '@/lib/db/host-provisioning';

export type ProvisioningMoveResult =
  /** The row was re-keyed from `from` to `to`. */
  | { status: 'moved'; provisioning: HostProvisioningRecord }
  /** No row at `from`: nothing to carry. No write was issued. */
  | { status: 'no-row' }
  /** `from` and `to` are the same address (or either is empty). No write. */
  | { status: 'noop' }
  /** A different host's row already holds `to`. Nothing was written. */
  | { status: 'conflict'; conflictWith: string }
  /** The move failed. Nothing is guaranteed about what was written. */
  | { status: 'error'; error: string };

/**
 * Re-key a provisioning row from one sidecar address to another.
 *
 * Note the ordering: the source row is read FIRST, and an occupied destination
 * is only a conflict when there is actually a row to merge into it. With no row
 * at `from` there is nothing that could be silently lost, and reporting a
 * conflict there would make the post-move steady state look like a failure
 * every time a sidecar re-registered.
 */
export async function moveProvisioningAddress(
  fromUrl: string,
  toUrl: string,
): Promise<ProvisioningMoveResult> {
  const from = normalizeSidecarUrl(fromUrl);
  const to = normalizeSidecarUrl(toUrl);
  if (!from || !to || from === to) return { status: 'noop' };

  try {
    const row = await getProvisioning(from);
    if (!row) return { status: 'no-row' };

    const occupant = await getProvisioning(to);
    if (occupant) {
      return { status: 'conflict', conflictWith: to };
    }

    const provisioning = await upsertProvisioning({
      sidecarUrl: to,
      hostOsOverride: row.hostOsOverride,
      masterUrlForHost: row.masterUrlForHost,
      masterWsPortForHost: row.masterWsPortForHost,
      notes: row.notes,
    });
    // Delete last: a crash between the two leaves a duplicate row, which an
    // operator can see and clear. The other order would lose the overrides.
    await deleteProvisioning(from);
    return { status: 'moved', provisioning };
  } catch (error: any) {
    return { status: 'error', error: (error?.message || String(error)).slice(0, 300) };
  }
}
