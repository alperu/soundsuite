import { NextRequest, NextResponse } from 'next/server';
import { generateCloudflaredConfig } from '@/lib/admin/cloudflare';
import { requireAdminAuth } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/cloudflare/config — the generated cloudflared config.yml.
 * Default JSON: { yaml, commands, ready, missing }.
 * With ?format=yaml: raw text/plain YAML (curl-friendly).
 */
export async function GET(request: NextRequest) {
  try {
    if (!(await requireAdminAuth(request))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const generated = await generateCloudflaredConfig();
    const url = new URL(request.url);
    if (url.searchParams.get('format') === 'yaml') {
      return new NextResponse(generated.yaml, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    return NextResponse.json(generated);
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
