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
 *
 * Per-host ONLY. No global master URL fallback — operator must explicitly
 * assign one per host or the master pushes nothing.
 *
 * Auth: matches /api/admin/gpu-fleet — none (admin-only Next routes; UI is
 * gated at the page layer).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  HostProvisioningRecord,
  deleteProvisioning,
  isValidHostOs,
  isValidWsPort,
  listProvisioning,
  normalizeMasterUrl,
  normalizeSidecarUrl,
  upsertProvisioning,
} from '@/lib/db/host-provisioning';

export async function GET() {
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
