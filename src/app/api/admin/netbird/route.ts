import { NextRequest, NextResponse } from 'next/server';
import { getNetbirdView, updateNetbirdSettings } from '@/lib/admin/netbird';
import { netbirdGate, netbirdFail } from '@/lib/admin/netbird-route';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** GET /api/admin/netbird — settings + last status. Secrets only as last-4 hints. */
export async function GET(req: NextRequest) {
  try {
    const denied = await netbirdGate(req);
    if (denied) return denied;
    return NextResponse.json(getNetbirdView(), { headers: NO_STORE });
  } catch (error) {
    return netbirdFail(error);
  }
}

/**
 * PUT /api/admin/netbird — partial update. Body:
 *   { setupKey?, hostname?, managementUrl?, wireguardPort?, externalIpMap?, enabled?,
 *     https?: { enabled?, domain?, cloudflareToken?, email? } }
 */
export async function PUT(req: NextRequest) {
  try {
    const denied = await netbirdGate(req);
    if (denied) return denied;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
    }
    return NextResponse.json(updateNetbirdSettings(body), { headers: NO_STORE });
  } catch (error) {
    return netbirdFail(error);
  }
}
