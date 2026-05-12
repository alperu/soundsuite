import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import AdminDashboard from '@/components/admin-dashboard';
import { getConfig, getModelDownloadStatus } from '@/lib/db/config';

const VALID_TABS = ['general', 'health', 'embedding', 'reranking', 'gpu', 'roletypes', 'roleassign', 'ocr', 'localai', 'aikeys', 'workers', 'redis', 'cache', 'filings', 'jobs', 'actionlog', 'drafts'] as const;

type TabKey = (typeof VALID_TABS)[number];

interface Props {
  params: Promise<{ tab?: string[] }>;
}

export default async function AdminPage({ params }: Props) {
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
