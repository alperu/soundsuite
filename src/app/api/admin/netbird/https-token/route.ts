import { NextRequest, NextResponse } from 'next/server';
import { removeHttpsToken } from '@/lib/admin/netbird';
import { netbirdGate, netbirdFail } from '@/lib/admin/netbird-route';

export const dynamic = 'force-dynamic';

/** DELETE /api/admin/netbird/https-token — remove the Cloudflare token. */
export async function DELETE(req: NextRequest) {
  try {
    const denied = await netbirdGate(req);
    if (denied) return denied;
    return NextResponse.json(removeHttpsToken());
  } catch (error) {
    return netbirdFail(error);
  }
}
