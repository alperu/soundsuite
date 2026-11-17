import { NextResponse } from 'next/server';
import { connectNetbirdNow, getNetbirdView } from '@/lib/netbird-runtime';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** POST /api/netbird/connect — make the NetBird companion again and connect now. */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    await connectNetbirdNow();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json(await getNetbirdView(), { headers: { 'Cache-Control': 'no-store' } });
}
