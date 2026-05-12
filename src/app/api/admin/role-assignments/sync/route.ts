import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/admin/role-assignments/sync?sidecarUrl=...
 *
 * Trigger a pushModelRegistry to that sidecar so it picks up assignment
 * edits without waiting for the next config push. Intended to be called by
 * the admin UI immediately after editing role-assignments for a host.
 */
export async function POST(req: NextRequest) {
  try {
    const sidecarUrl = req.nextUrl.searchParams.get('sidecarUrl');
    if (!sidecarUrl) {
      return NextResponse.json({ error: 'sidecarUrl is required' }, { status: 400 });
    }
    const { pushModelRegistry } = await import('@/lib/gpu/fleet-router');
    const result = await pushModelRegistry(sidecarUrl);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
