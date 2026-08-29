import { NextRequest, NextResponse } from 'next/server';
import { updateUser, deleteUser, getUser, type AdminRole } from '@/lib/admin/user-store';
import { requireAdminAuth } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/admin/users/[id] — update a user.
 * Body: { password?, role?, enabled? } (password resets the credential).
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    if (!(await requireAdminAuth(req))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { password, role, enabled } = body as {
      password?: string;
      role?: AdminRole;
      enabled?: boolean;
    };

    if (!(await getUser(id))) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const user = await updateUser(id, { password, role, enabled });
    return NextResponse.json({ user });
  } catch (error: any) {
    const msg = error?.message || String(error);
    const status = /must be|Nothing to update/.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

/** DELETE /api/admin/users/[id] — remove a user. */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    if (!(await requireAdminAuth(req))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const { id } = await params;
    if (!(await getUser(id))) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    await deleteUser(id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}
