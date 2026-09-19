import { Suspense } from 'react';
import { EtlPanel } from '@/components/haystack-etl/etl-panel';

/**
 * Haystack ETL — give a folder path, let the model read the PDFs and propose
 * the case, the kinds, the titles, the links and a tidy folder layout; review;
 * apply. Backed by `ssAutoIngestPlan` / `ssAutoIngestApply` through the
 * same-origin proxy, so what this page does an MCP client can do too.
 */
export default function HaystackEtlPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">Loading…</div>}>
      <EtlPanel />
    </Suspense>
  );
}
