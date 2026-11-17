import { NextResponse } from 'next/server';
import {
  AuthInputError, SESSION_HOURS, adminExists, checkPassword, clientIp, cookieValue, createSession,
  loginBlocked, noteLoginFail, requireAdmin, sessionCookie, sessionUser, setAdmin,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

/** GET /api/auth — { setup: true } before the first admin exists; { user } when signed in. */
export async function GET(req: Request) {
  const setup = !adminExists();
  let user: string | null = null;
  try { user = setup ? null : sessionUser(cookieValue(req)); } catch { user = null; }
  return NextResponse.json({ setup, user }, { headers: NO_STORE });
}

function signedIn(req: Request, user: string) {
  const res = NextResponse.json({ ok: true, user }, { headers: NO_STORE });
  res.headers.append('Set-Cookie', sessionCookie(req, createSession(user), SESSION_HOURS * 3600));
  return res;
}

/**
 * POST /api/auth
 *   { action: 'login', user, password }
 *   { action: 'setup', user, password }          only while no admin exists
 *   { action: 'password', password, newPassword } signed in; ends other sessions
 *   { action: 'logout' }
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = b?.action;
  const user = typeof b?.user === 'string' ? b.user.trim() : '';
  const password = typeof b?.password === 'string' ? b.password : '';
  try {
    if (action === 'logout') {
      const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
      res.headers.append('Set-Cookie', sessionCookie(req, '', 0));
      return res;
    }
    if (action === 'setup') {
      if (adminExists()) return NextResponse.json({ error: 'An admin account already exists.' }, { status: 409 });
      setAdmin(user, password);
      return signedIn(req, user);
    }
    if (action === 'login') {
      const ip = clientIp(req);
      if (loginBlocked(ip)) return NextResponse.json({ error: 'Too many failed sign-ins. Wait 5 minutes.' }, { status: 429 });
      if (!checkPassword(user, password)) {
        noteLoginFail(ip);
        return NextResponse.json({ error: 'Wrong user name or password.' }, { status: 401 });
      }
      return signedIn(req, user);
    }
    if (action === 'password') {
      const denied = requireAdmin(req);
      if (denied) return denied;
      const me = sessionUser(cookieValue(req));
      if (!me || !checkPassword(me, password)) return NextResponse.json({ error: 'Current password is wrong.' }, { status: 401 });
      const next = typeof b?.newPassword === 'string' ? b.newPassword : '';
      setAdmin(me, next);
      return signedIn(req, me);
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (err) {
    if (err instanceof AuthInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
