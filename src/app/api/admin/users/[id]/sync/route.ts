import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/auth';
import { setSyncLogin, SyncLoginError } from '@/lib/admin/sync-login';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * PUT /api/admin/users/[id]/sync — Sidecar sync login. Admin only.
 * Body: { enabled?, password? (write only), roots?: string[] }.
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const user = await requireAdminAuth(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const updated = await setSyncLogin(id, body ?? {});
    return NextResponse.json({ user: updated });
  } catch (e) {
    if (e instanceof SyncLoginError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, { status: 500 });
  }
}
