import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/admin/user-store';
import { createDashboardSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/auth/login — body: { username, password }.
 * On success sets the httpOnly session cookie and returns the public user.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { username, password } = body as { username?: string; password?: string };

    if (!username || !password) {
      return NextResponse.json({ error: 'username and password are required' }, { status: 400 });
    }

    const user = await verifyPassword(username, password);
    if (!user) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    }

    const token = await createDashboardSession(user.username, {
      userAgent: req.headers.get('user-agent'),
      ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    });

    const res = NextResponse.json({
      user: { username: user.username, role: user.role, lastLoginAt: user.lastLoginAt },
    });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return res;
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}
