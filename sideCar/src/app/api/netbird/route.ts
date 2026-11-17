import { NextResponse } from 'next/server';
import { NetbirdInputError, updateSettings } from '@/lib/netbird';
import { netbirdGate } from '@/lib/netbird-auth';
import { applyNow, getNetbirdView, netbirdDir } from '@/lib/netbird-runtime';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

/** GET /api/netbird — settings, companion state and live status. Secrets only as last-4 hints. */
export async function GET(req: Request) {
  const denied = netbirdGate(req);
  if (denied) return denied;
  return NextResponse.json(await getNetbirdView(), { headers: NO_STORE });
}

/**
 * PUT /api/netbird — partial update, then apply at once. Body:
 *   { setupKey?, hostname?, managementUrl?, wireguardPort?, externalIpMap?, enabled?,
 *     https?: { enabled?, domain?, email?, cloudflareToken? } }
 */
export async function PUT(req: Request) {
  const denied = netbirdGate(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  try {
    updateSettings(netbirdDir(), body);
  } catch (err) {
    if (err instanceof NetbirdInputError) return NextResponse.json({ error: err.message }, { status: 400, headers: NO_STORE });
    throw err;
  }
  await applyNow();
  return NextResponse.json(await getNetbirdView(), { headers: NO_STORE });
}
