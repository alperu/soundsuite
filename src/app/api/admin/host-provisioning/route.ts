/**
 * Per-sidecar host provisioning overrides.
 *
 *  GET    /api/admin/host-provisioning
 *           → { provisioning: HostProvisioningRecord[], globalMasterUrl: string|null }
 *  PUT    /api/admin/host-provisioning
 *           body { sidecarUrl, hostOsOverride?, masterUrlForHost?, notes? }
 *           Upserts. Returns saved record.
 *  DELETE /api/admin/host-provisioning?sidecarUrl=...
 *           Clears the row → host falls back to global default.
 *
 * Auth: matches /api/admin/gpu-fleet — none (admin-only Next routes; UI is
 * gated at the page layer).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  HostProvisioningRecord,
  deleteProvisioning,
  isValidHostOs,
  listProvisioning,
  normalizeMasterUrl,
  normalizeSidecarUrl,
  upsertProvisioning,
} from '@/lib/db/host-provisioning';
import { getCanonicalMasterUrl } from '@/lib/gpu/master-identity';

export async function GET() {
  try {
    const [provisioning, globalMasterUrl] = await Promise.all([
      listProvisioning(),
      getCanonicalMasterUrl(),
    ]);
    return NextResponse.json({ provisioning, globalMasterUrl });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
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
          { error: "hostOsOverride must be 'darwin', 'win32', 'linux', or empty" },
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

    const notes = body?.notes != null ? String(body.notes) : null;

    const saved = await upsertProvisioning({
      sidecarUrl,
      hostOsOverride,
      masterUrlForHost,
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

export async function DELETE(request: NextRequest) {
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
