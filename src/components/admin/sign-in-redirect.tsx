'use client';

/**
 * Rendered by a dashboard page whose API call answered 401: sends the browser
 * to the admin sign-in page and brings it back to the same URL afterwards.
 * Shown instead of a misleading "not found" when the real cause is a missing
 * dashboard session on a remotely-reachable deployment.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { loginUrlForCurrentPage } from '@/lib/admin/login-redirect';

/** True when a dashboard API response means "sign in first". */
export function isAuthRequired(res: Pick<Response, 'status'>): boolean {
  return res.status === 401;
}

export default function SignInRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace(loginUrlForCurrentPage());
  }, [router]);
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <p className="text-gray-500 text-lg">Sign-in required</p>
        <p className="text-gray-400 text-sm mt-1">Taking you to the sign-in page…</p>
      </div>
    </div>
  );
}
