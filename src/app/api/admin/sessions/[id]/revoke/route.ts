import { NextRequest, NextResponse } from 'next/server';
import { revokeSession } from '@/lib/admin/session-store';
import { requireAdminAuth } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/** POST /api/admin/sessions/[id]/revoke — revoke a session (idempotent). */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    if (!(await requireAdminAuth(req))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const { id } = await params;
    const session = await revokeSession(id);
    return NextResponse.json({ session });
  } catch (error: any) {
    const msg = error?.message || String(error);
    const status = msg === 'Session not found' ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
