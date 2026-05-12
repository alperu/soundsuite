import { NextRequest, NextResponse } from 'next/server';
import {
  listAssignmentsForHost,
  listAllAssignments,
  setAssignment,
  removeAssignment,
  type AssignmentInput,
} from '@/lib/db/role-registry';

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
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
