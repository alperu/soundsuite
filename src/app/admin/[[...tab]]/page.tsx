import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import AdminDashboard from '@/components/admin-dashboard';
import { getConfig, getModelDownloadStatus } from '@/lib/db/config';
import { getSessionUser, SESSION_COOKIE } from '@/lib/admin/auth';

const VALID_TABS = ['general', 'health', 'embedding', 'reranking', 'gpu', 'roletypes', 'roleassign', 'hostprov', 'ocr', 'localai', 'rlm', 'aikeys', 'aiservices', 'workers', 'redis', 'cache', 'filings', 'jobs', 'actionlog', 'drafts', 'cloudflare', 'users', 'sessions'] as const;

type TabKey = (typeof VALID_TABS)[number];

interface Props {
  params: Promise<{ tab?: string[] }>;
}

export default async function AdminPage({ params }: Props) {
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  const authUser = sessionToken ? await getSessionUser(sessionToken) : null;
  if (!authUser) {
    redirect('/admin/login');
  }

  const { tab } = await params;
  const tabKey = (tab?.[0] ?? 'general') as TabKey;

  if (!VALID_TABS.includes(tabKey) || (tab && tab.length > 1)) {
    redirect('/admin/general');
  }

  const config = await getConfig();
  const modelDownloads = await getModelDownloadStatus();

  return (
    <div className="mx-auto px-6 py-4">
      <Suspense fallback={<div className="text-gray-500 p-6">Loading dashboard...</div>}>
        <AdminDashboard initialConfig={config} initialModelDownloads={modelDownloads} initialTab={tabKey} />
      </Suspense>
    </div>
  );
}
