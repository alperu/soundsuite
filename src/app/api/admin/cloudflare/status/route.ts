import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareStatus } from '@/lib/admin/cloudflare';
import { requireAdminAuth } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/cloudflare/status — live tunnel health:
 * cloudflared process, local metrics endpoint, public hostname reachability.
 * Probe failures are reported as status values, never as HTTP errors.
 */
export async function GET(req: NextRequest) {
  try {
    if (!(await requireAdminAuth(req))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const status = await getCloudflareStatus();
    return NextResponse.json({ status });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
