import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

/** GET /api/admin/auth/me — returns the logged-in user or 401. */
export async function GET(req: NextRequest) {
  try {
    const user = await requireAdminAuth(req);
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    return NextResponse.json({ user });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}
