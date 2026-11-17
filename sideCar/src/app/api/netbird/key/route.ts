import { NextResponse } from 'next/server';
import { removeSecret } from '@/lib/netbird';
import { netbirdGate } from '@/lib/netbird-auth';
import { applyNow, getNetbirdView, netbirdDir } from '@/lib/netbird-runtime';

export const dynamic = 'force-dynamic';

/** DELETE /api/netbird/key — remove the setup key and turn NetBird off. */
export async function DELETE(req: Request) {
  const denied = netbirdGate(req);
  if (denied) return denied;
  removeSecret(netbirdDir(), 'setupKey');
  await applyNow();
  return NextResponse.json(await getNetbirdView(), { headers: { 'Cache-Control': 'no-store' } });
}
