import { NextRequest, NextResponse } from 'next/server';
import { revokeSessionByToken, SESSION_COOKIE } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

/** POST /api/admin/auth/logout — revokes the cookie session and clears the cookie. */
export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (token) {
      await revokeSessionByToken(token);
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
    return res;
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}
