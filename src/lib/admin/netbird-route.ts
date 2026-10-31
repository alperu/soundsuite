import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/auth';
import { NetbirdError } from '@/lib/admin/netbird';

/** Admin role only (viewers get 403). Shared by the /api/admin/netbird routes. */
export async function netbirdGate(req: NextRequest): Promise<NextResponse | null> {
  const user = await requireAdminAuth(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return null;
}

export function netbirdFail(error: unknown): NextResponse {
  if (error instanceof NetbirdError) return NextResponse.json({ error: error.message }, { status: error.status });
  const msg = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
}
