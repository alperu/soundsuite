import { NextRequest, NextResponse } from 'next/server';
import {
  listAssignmentsForHost,
  listAllAssignments,
  setAssignment,
  removeAssignment,
  type AssignmentInput,
} from '@/lib/db/role-registry';
import { clearSidecarRole } from '@/lib/gpu/status-cache';

/**
 * Mode names ("ss-ocr") → role keys used in CachedSidecarStatus.containers
 * ("ocr"). Both the sidecar and the route resolver index by the short name.
 */
function modeToRoleKey(mode: string): string {
  return mode.startsWith('ss-') ? mode.slice(3) : mode;
}

/**
 * Best-effort: push the updated role config to the sidecar so it stops the
 * container. Cache invalidation already prevents new routes, but pushing
 * here also frees VRAM. Errors are swallowed — the sidecar may be offline
 * and that's fine; the route is already unselected.
 */
async function syncSidecar(sidecarUrl: string): Promise<void> {
  try {
    const { pushModelRegistry } = await import('@/lib/gpu/fleet-router');
    await pushModelRegistry(sidecarUrl);
  } catch {
    /* sidecar may be offline; routing already updated locally */
  }
}

/**
 * GET /api/admin/role-assignments?sidecarUrl=...
 * If sidecarUrl is provided: returns roles assigned to that host.
 * Otherwise: returns all assignments across all hosts.
 */
export async function GET(req: NextRequest) {
  try {
    const sidecarUrl = req.nextUrl.searchParams.get('sidecarUrl');
    if (sidecarUrl) {
      const rows = await listAssignmentsForHost(sidecarUrl);
      return NextResponse.json({
        assignments: rows.map(r => ({
          mode: r.mode,
          enabled: r.enabled,
          minOnline: r.minOnline,
          idleTimeoutMin: r.idleTimeoutMin,
          modelOverride: r.modelOverride,
          runtime: (r as { runtime?: string | null }).runtime ?? null,
        })),
      });
    }
    const rows = await listAllAssignments();
    return NextResponse.json({ assignments: rows });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/admin/role-assignments — upsert one assignment.
 * Body: { sidecarUrl, mode, enabled?, minOnline?, idleTimeoutMin?, modelOverride? }
 * Legacy compat: accepts `roleTypeName` as an alias for `mode`.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<AssignmentInput> & { roleTypeName?: string };
    // Back-compat: older callers send roleTypeName as the short role name
    // (e.g. "embedding"). Map to the new mode name ("ss-embedding").
    let mode = body.mode;
    if (!mode && body.roleTypeName) {
      mode = body.roleTypeName.startsWith('ss-')
        ? body.roleTypeName
        : `ss-${body.roleTypeName}`;
    }
    if (!body.sidecarUrl || !mode) {
      return NextResponse.json(
        { error: 'sidecarUrl and mode are required' },
        { status: 400 },
      );
    }
    const row = await setAssignment({ ...body, sidecarUrl: body.sidecarUrl, mode } as AssignmentInput);
    // If the role was disabled, invalidate the local route cache for this
    // (host, role) pair and push the new config so the sidecar stops the
    // container. Without this, resolveEndpoint keeps routing to the host
    // until the next heartbeat (~5 s) and documents fail with fetch errors.
    if (body.enabled === false) {
      clearSidecarRole(body.sidecarUrl, modeToRoleKey(mode));
      void syncSidecar(body.sidecarUrl);
    }
    return NextResponse.json({ assignment: row });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/admin/role-assignments?sidecarUrl=...&mode=...
 * Legacy compat: accepts `roleTypeName` as an alias for `mode`.
 */
export async function DELETE(req: NextRequest) {
  try {
    const sidecarUrl = req.nextUrl.searchParams.get('sidecarUrl');
    let mode = req.nextUrl.searchParams.get('mode');
    if (!mode) {
      const legacy = req.nextUrl.searchParams.get('roleTypeName');
      if (legacy) mode = legacy.startsWith('ss-') ? legacy : `ss-${legacy}`;
    }
    if (!sidecarUrl || !mode) {
      return NextResponse.json(
        { error: 'sidecarUrl and mode are required' },
        { status: 400 },
      );
    }
    await removeAssignment(sidecarUrl, mode);
    // Invalidate the route cache immediately so the resolver stops picking
    // this host for the deleted role. Also push the config so the sidecar
    // tears down the container.
    clearSidecarRole(sidecarUrl, modeToRoleKey(mode));
    void syncSidecar(sidecarUrl);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
