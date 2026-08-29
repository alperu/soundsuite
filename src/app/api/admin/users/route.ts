import { NextRequest, NextResponse } from 'next/server';
import { listUsers, createUser, type AdminRole } from '@/lib/admin/user-store';
import { requireAdminAuth } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

/** GET /api/admin/users — list admin users (never includes password hashes). */
export async function GET(req: NextRequest) {
  try {
    if (!(await requireAdminAuth(req))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const users = await listUsers();
    return NextResponse.json({ users });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}

/** POST /api/admin/users — create a user. Body: { username, password, role? } */
export async function POST(req: NextRequest) {
  try {
    if (!(await requireAdminAuth(req))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const { username, password, role } = body as {
      username?: string;
      password?: string;
      role?: AdminRole;
    };

    if (!username || !password) {
      return NextResponse.json({ error: 'username and password are required' }, { status: 400 });
    }

    const user = await createUser({ username, password, role });
    return NextResponse.json({ user }, { status: 201 });
  } catch (error: any) {
    const msg = error?.message || String(error);
    const status = msg === 'User already exists' ? 409 : /must be/.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
