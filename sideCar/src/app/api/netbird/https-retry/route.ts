import { NextResponse } from 'next/server';
import { getNetbirdView, retryHttpsNow } from '@/lib/netbird-runtime';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** POST /api/netbird/https-retry — restart Caddy so it asks for the certificate now. */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    await retryHttpsNow();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json(await getNetbirdView(), { headers: { 'Cache-Control': 'no-store' } });
}
