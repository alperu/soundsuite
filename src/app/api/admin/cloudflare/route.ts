import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareSettings, updateCloudflareSettings } from '@/lib/admin/cloudflare';
import { requireAdminAuth } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/cloudflare — stored tunnel settings, secrets masked
 * (last 4 characters only).
 */
export async function GET(req: NextRequest) {
  try {
    if (!(await requireAdminAuth(req))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const settings = await getCloudflareSettings();
    return NextResponse.json({ settings });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/admin/cloudflare — partial update. Masked placeholder values for
 * secret fields are ignored so an unchanged form save keeps stored secrets.
 * Body: { domain?, accountId?, apiKey?, tunnelId?, tunnelToken?,
 *         credentialsPath?, ingressPaths?, metricsAddress? }
 */
export async function PUT(request: NextRequest) {
  try {
    if (!(await requireAdminAuth(request))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
    }
    const settings = await updateCloudflareSettings(body);
    return NextResponse.json({ ok: true, settings });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
