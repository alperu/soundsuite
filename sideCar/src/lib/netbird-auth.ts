/**
 * Gate for the NetBird endpoints. The rest of the sidecar API is open on the
 * LAN; these endpoints store a setup key and a Cloudflare token, so an operator
 * can lock them with SIDECAR_ADMIN_TOKEN (env). When it is set, a request needs
 * `Authorization: Bearer <token>`. Secrets are never returned either way.
 * Cross-origin pages cannot call PUT/DELETE here: the CORS preflight in
 * middleware.ts allows only GET and POST.
 */
import crypto from 'crypto';
import { NextResponse } from 'next/server';

export function netbirdGate(req: Request, env: NodeJS.ProcessEnv = process.env): NextResponse | null {
  const token = env.SIDECAR_ADMIN_TOKEN?.trim();
  if (!token) return null;
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  if (got && crypto.timingSafeEqual(a, b)) return null;
  return NextResponse.json({ error: 'Admin token required (Authorization: Bearer ...).' }, { status: 401 });
}
