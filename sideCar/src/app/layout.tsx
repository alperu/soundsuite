import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import './globals.css';
import SideMenu from '@/components/side-menu';
import { SESSION_COOKIE, adminExists, sessionUser } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Sound Suite GPU Orchestrator',
  description: 'Multi-container lifecycle manager',
};

export const dynamic = 'force-dynamic';

/** Every page needs a signed-in admin, except /login. */
async function currentUser(): Promise<string | null> {
  try {
    if (!adminExists()) return null;
    return sessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const full = (await headers()).get('x-sidecar-path') || '/';
  const onLogin = full === '/login' || full.startsWith('/login?');
  const user = await currentUser();
  if (!user && !onLogin) redirect(`/login?next=${encodeURIComponent(full)}`);

  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-800 antialiased">
        {user && !onLogin ? (
          <div className="flex min-h-screen">
            <SideMenu user={user} />
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
