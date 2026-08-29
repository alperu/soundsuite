/**
 * Sign-in page for Sound Suite's own self-hosted admin dashboard (localhost).
 * Authenticates operators against the local AdminUser table via
 * /api/admin/auth/login. This is first-party UI for this application — it
 * imitates no external organization or service.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ensureDefaultAdmin } from '@/lib/admin/user-store';
import { getSessionUser, SESSION_COOKIE } from '@/lib/admin/auth';
import LoginForm from '@/components/admin/login-form';

export const dynamic = 'force-dynamic';

export default async function AdminLoginPage() {
  // First-run bootstrap: seed the initial admin account if none exists yet.
  const seeded = await ensureDefaultAdmin();

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token && (await getSessionUser(token))) {
    redirect('/admin/general');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <LoginForm showBootstrapHint={seeded} />
    </div>
  );
}
