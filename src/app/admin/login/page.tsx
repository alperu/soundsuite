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
import { afterLoginPath, safeNextPath } from '@/lib/admin/login-redirect';

export const dynamic = 'force-dynamic';

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // First-run bootstrap: seed the initial admin account if none exists yet.
  const seeded = await ensureDefaultAdmin();

  // `?next=` is set by dashboard pages that hit a 401 (see
  // `@/components/admin/sign-in-redirect`). Only a same-origin path is honoured.
  const next = safeNextPath((await searchParams).next);

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token && (await getSessionUser(token))) {
    redirect(afterLoginPath(next));
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <LoginForm showBootstrapHint={seeded} next={next} />
    </div>
  );
}
