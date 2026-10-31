import { NextRequest, NextResponse } from 'next/server';
import { removeNetbirdKey } from '@/lib/admin/netbird';
import { netbirdGate, netbirdFail } from '@/lib/admin/netbird-route';

export const dynamic = 'force-dynamic';

/** DELETE /api/admin/netbird/key — remove the setup key and turn NetBird off. */
export async function DELETE(req: NextRequest) {
  try {
    const denied = await netbirdGate(req);
    if (denied) return denied;
    return NextResponse.json(removeNetbirdKey());
  } catch (error) {
    return netbirdFail(error);
  }
}
