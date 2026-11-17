import { NextResponse } from 'next/server';
import { removeSecret } from '@/lib/netbird';
import { applyNow, getNetbirdView, netbirdDir } from '@/lib/netbird-runtime';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** DELETE /api/netbird/https-token — remove the Cloudflare token and turn HTTPS off. */
export async function DELETE(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  removeSecret(netbirdDir(), 'cloudflareToken');
  await applyNow();
  return NextResponse.json(await getNetbirdView(), { headers: { 'Cache-Control': 'no-store' } });
}
