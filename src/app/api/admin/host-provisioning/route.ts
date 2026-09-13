/**
 * Per-sidecar host provisioning overrides.
 *
 *  GET    /api/admin/host-provisioning
 *           → { provisioning: HostProvisioningRecord[], defaultWsPort: number }
 *  PUT    /api/admin/host-provisioning
 *           body { sidecarUrl, hostOsOverride?, masterUrlForHost?, masterWsPortForHost?, notes? }
 *           Upserts. Returns saved record.
 *  DELETE /api/admin/host-provisioning?sidecarUrl=...
 *           Clears the row → master will no longer push identity to this host.
 *  PATCH  /api/admin/host-provisioning
 *           body { fromSidecarUrl, toSidecarUrl }
 *           Corrects a host's address: moves the provisioning row AND re-keys
 *           the live registry + status cache, then forgets the old address.
 *           Recovery path for an entry stuck at an address the host has left,
 *           without hand-editing a config file inside a container.
 *
 * Per-host ONLY. No global master URL fallback — operator must explicitly
 * assign one per host or the master pushes nothing.
 *
 * Auth: matches /api/admin/gpu-fleet — none (admin-only Next routes; UI is
 * gated at the page layer).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApiAccess } from '@/lib/api/route-guard';
import {
  HostProvisioningRecord,
  deleteProvisioning,
  getProvisioning,
  isValidHostOs,
  isValidWsPort,
  listProvisioning,
  normalizeMasterUrl,
  normalizeSidecarUrl,
  upsertProvisioning,
} from '@/lib/db/host-provisioning';

export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'host-provisioning');
  if (denied) return denied;

  try {
    const provisioning = await listProvisioning();
    const defaultWsPort = parseInt(process.env.GPU_WS_PORT || '3002', 10);
    return NextResponse.json({ provisioning, defaultWsPort });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'host-provisioning');
  if (denied) return denied;

  try {
    const body = await request.json();
    const sidecarUrl = normalizeSidecarUrl(String(body?.sidecarUrl ?? ''));
    if (!sidecarUrl) {
      return NextResponse.json({ error: 'sidecarUrl is required' }, { status: 400 });
    }

    // Validate hostOsOverride. Empty string / null / undefined → null.
    let hostOsOverride: HostProvisioningRecord['hostOsOverride'] = null;
    if (body?.hostOsOverride != null && body.hostOsOverride !== '') {
      if (!isValidHostOs(body.hostOsOverride)) {
        return NextResponse.json(
          { error: "hostOsOverride must be 'mac-docker-ollama', 'windows-docker-wsl2', 'linux', or empty" },
          { status: 400 },
        );
      }
      hostOsOverride = body.hostOsOverride;
    }

    // Validate masterUrlForHost — scheme + host required when present.
    let masterUrlForHost: string | null = null;
    if (body?.masterUrlForHost != null && String(body.masterUrlForHost).trim() !== '') {
      const candidate = normalizeMasterUrl(String(body.masterUrlForHost));
      if (!candidate || !/^https?:\/\/[^/\s]+/i.test(candidate)) {
        return NextResponse.json(
          { error: 'masterUrlForHost must be an http(s) URL or empty' },
          { status: 400 },
        );
      }
      masterUrlForHost = candidate;
    }

    // Validate masterWsPortForHost — positive 16-bit int when present.
    let masterWsPortForHost: number | null = null;
    if (body?.masterWsPortForHost != null && body.masterWsPortForHost !== '') {
      const n = typeof body.masterWsPortForHost === 'number'
        ? body.masterWsPortForHost
        : parseInt(String(body.masterWsPortForHost), 10);
      if (!isValidWsPort(n)) {
        return NextResponse.json(
          { error: 'masterWsPortForHost must be an integer 1–65535 or empty' },
          { status: 400 },
        );
      }
      masterWsPortForHost = n;
    }

    const notes = body?.notes != null ? String(body.notes) : null;

    const saved = await upsertProvisioning({
      sidecarUrl,
      hostOsOverride,
      masterUrlForHost,
      masterWsPortForHost,
      notes,
    });
    return NextResponse.json(saved);
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}

/**
 * Correct a host's advertised address.
 *
 * The sidecar revalidates its own address now, so this is for the cases it
 * cannot fix itself: an entry left behind by a host that is gone, or one whose
 * address the operator knows better than detection does (a sidecar advertising a
 * hostname is deliberately never auto-flapped). Moves the provisioning row and
 * re-keys the live registry + status cache in one step, so no stale entry and no
 * duplicate survives the correction.
 */
export async function PATCH(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'host-provisioning');
  if (denied) return denied;

  try {
    const body = await request.json();
    const from = normalizeSidecarUrl(String(body?.fromSidecarUrl ?? ''));
    const to = normalizeSidecarUrl(String(body?.toSidecarUrl ?? ''));
    if (!from || !to) {
      return NextResponse.json(
        { error: 'fromSidecarUrl and toSidecarUrl are both required' },
        { status: 400 },
      );
    }
    if (!/^https?:\/\/[^/\s]+/i.test(to)) {
      return NextResponse.json({ error: 'toSidecarUrl must be an http(s) URL' }, { status: 400 });
    }
    if (from === to) {
      return NextResponse.json({ error: 'fromSidecarUrl and toSidecarUrl are identical' }, { status: 400 });
    }

    // A row already at the destination is a conflict, not something to overwrite:
    // the operator would silently lose that host's OS pin and master URL.
    const existingAtTarget = await getProvisioning(to);
    if (existingAtTarget) {
      return NextResponse.json(
        { error: `a provisioning row already exists for ${to} — delete it first`, conflict: to },
        { status: 409 },
      );
    }

    const row = await getProvisioning(from);
    let provisioning: HostProvisioningRecord | null = null;
    if (row) {
      provisioning = await upsertProvisioning({
        sidecarUrl: to,
        hostOsOverride: row.hostOsOverride,
        masterUrlForHost: row.masterUrlForHost,
        masterWsPortForHost: row.masterWsPortForHost,
        notes: row.notes,
      });
      await deleteProvisioning(from);
    }

    // Forget the old address rather than re-keying its live socket here. The
    // registry key is re-keyed ONLY on the sidecar-initiated path in ws-relay,
    // where the connection's own `registeredUrl` moves with it; doing it from a
    // route would leave that closure variable pointing at the old key, and every
    // subsequent heartbeat from a live sidecar would be dropped on the floor.
    // Closing instead makes the sidecar reconnect and register its own current
    // address — which, post-fix, it revalidates before it does so.
    const { removeSidecar } = await import('@/lib/gpu/fleet-router');
    const removedOld = await removeSidecar(from);

    return NextResponse.json({ ok: true, from, to, provisioning, removedOld });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'host-provisioning');
  if (denied) return denied;

  try {
    const sidecarUrl = normalizeSidecarUrl(
      request.nextUrl.searchParams.get('sidecarUrl') ?? '',
    );
    if (!sidecarUrl) {
      return NextResponse.json({ error: 'sidecarUrl is required' }, { status: 400 });
    }
    await deleteProvisioning(sidecarUrl);
    return NextResponse.json({ ok: true, sidecarUrl });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
