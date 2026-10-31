import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/auth';
import { syncView } from '@/lib/admin/sync-login';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/users/sync — receiver accounts (read only), receiver
 * settings as "set" / "not set". For an admin, receiver accounts are linked
 * to users by username first (no user → viewer with dashboard login off).
 * Never returns a password or hash.
 */
export async function GET(req: NextRequest) {
  const user = await requireAdminAuth(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const view = await syncView({}, { link: user.role === 'admin' });
  return NextResponse.json(view, { headers: { 'Cache-Control': 'no-store' } });
}
