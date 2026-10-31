/**
 * /api/admin/sidecar-master — the "Sidecar master" setting (task 57 / 3.6).
 *
 *   GET  → settings (token masked: hasToken + last 4) and follow status.
 *   PUT  → save { source?, masterUrl?, linkUrl?, token?, clearToken? }. Audit row, no token in it.
 *   POST → test the connection with the given or the saved token. Answer never carries the token.
 *
 * Admin role only (viewers get 403), same gate as /api/admin/netbird.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/auth';
import {
  FleetSourceError,
  getFleetSourceView,
  getFollowStatus,
  refreshFollowedFleet,
  saveFleetSourceSettings,
  testMasterConnection,
  type FleetSourcePatch,
} from '@/lib/db/fleet-source';

export const dynamic = 'force-dynamic';

async function gate(req: NextRequest): Promise<{ username: string } | NextResponse> {
  const user = await requireAdminAuth(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return { username: user.username };
}

function fail(error: unknown): NextResponse {
  if (error instanceof FleetSourceError) return NextResponse.json({ error: error.message }, { status: error.status });
  const msg = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const who = await gate(req);
  if (who instanceof NextResponse) return who;
  try {
    const [settings, status] = await Promise.all([getFleetSourceView(), getFollowStatus()]);
    return NextResponse.json({ settings, status });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req: NextRequest) {
  const who = await gate(req);
  if (who instanceof NextResponse) return who;
  try {
    const body = (await req.json().catch(() => ({}))) as FleetSourcePatch;
    const patch: FleetSourcePatch = {};
    if (body.source !== undefined) patch.source = body.source;
    if (typeof body.masterUrl === 'string') patch.masterUrl = body.masterUrl;
    if (typeof body.linkUrl === 'string') patch.linkUrl = body.linkUrl;
    if (typeof body.token === 'string' && body.token.trim()) patch.token = body.token;
    if (body.clearToken === true) patch.clearToken = true;
    const settings = await saveFleetSourceSettings(patch, who.username);
    // First read right away so the status shows up without waiting for the follower tick.
    if (settings.following) await refreshFollowedFleet().catch(() => null);
    const status = await getFollowStatus();
    return NextResponse.json({ settings, status });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  const who = await gate(req);
  if (who instanceof NextResponse) return who;
  try {
    const body = (await req.json().catch(() => ({}))) as { masterUrl?: unknown; token?: unknown };
    const result = await testMasterConnection({
      masterUrl: typeof body.masterUrl === 'string' ? body.masterUrl : undefined,
      token: typeof body.token === 'string' ? body.token : undefined,
    }, who.username);
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
