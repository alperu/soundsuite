import { NextResponse } from 'next/server';
import { CF_TOKEN_FILE, readSecret, readSettings, testCloudflareToken } from '@/lib/netbird';
import { netbirdDir } from '@/lib/netbird-runtime';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/netbird/https-token/test { token?, domain? } — test a Cloudflare
 * token. Without `token` it tests the saved one. Nothing is saved.
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { token?: unknown; domain?: unknown };
  const dir = netbirdDir();
  const token = typeof b.token === 'string' && b.token.trim() ? b.token.trim() : readSecret(dir, CF_TOKEN_FILE);
  if (!token) return NextResponse.json({ error: 'No token: paste one or save one first.' }, { status: 400 });
  const domain = typeof b.domain === 'string' && b.domain.trim() ? b.domain.trim().toLowerCase() : readSettings(dir).https.domain;
  if (!domain) return NextResponse.json({ error: 'Set the domain first.' }, { status: 400 });
  return NextResponse.json(await testCloudflareToken(token, domain), { headers: { 'Cache-Control': 'no-store' } });
}
