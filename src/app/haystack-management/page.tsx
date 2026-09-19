'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import { HaystackBlockView } from '@/components/haystack-block-view/haystack-block-view';
import type { ScopeSelection } from '@/components/haystack-block-view/types';
import { setPreference } from '@/lib/indexed-db';

/**
 * Haystack Management — the rete block view, opened on the Editor tab (the
 * mapping workbench), exactly what the nav entry used to reach through
 * `/scope?tab=editor`. The ETL page and the op catalogue are its sub-pages.
 *
 * `?case=<id>` narrows to one case; `?tab=filtering` opens the other tab;
 * `?focus=<kind>:<id>` preselects an entity in the worklist.
 */
function HaystackManagementBody() {
  const params = useSearchParams();
  const initialTab = params.get('tab') === 'filtering' ? 'filtering' : 'editor';
  const caseId = params.get('case');
  const focusRaw = params.get('focus');
  const focusEntity = (() => {
    if (!focusRaw) return undefined;
    const sep = focusRaw.indexOf(':');
    if (sep <= 0 || sep === focusRaw.length - 1) return undefined;
    return { kind: focusRaw.slice(0, sep), id: focusRaw.slice(sep + 1) };
  })();

  // Same persistence as /scope: the search UI reads these keys.
  const handleScopeChange = useCallback(async (scope: ScopeSelection) => {
    const empty = scope.caseIds.length === 0 && scope.filingIds.length === 0;
    if (!empty) {
      await setPreference('search.scopeSet', { ...scope, version: 1 });
    }
    await setPreference('search.scopeSetActive', !empty);
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-2.5 flex-shrink-0">
        <h1 className="text-sm font-semibold text-gray-800">Haystack Management</h1>
        <nav className="ml-auto flex items-center gap-3 text-[12px]">
          <Link href="/haystack-management/etl" className="text-indigo-700 hover:underline">Haystack ETL</Link>
          <Link href="/haystack-management/ops" className="text-gray-600 hover:text-blue-600">Op catalogue</Link>
        </nav>
      </header>
      <div className="flex-1 min-h-0">
        <HaystackBlockView
          scope={caseId ? { kind: 'case', caseId } : { kind: 'all' }}
          initialTab={initialTab}
          focusEntity={focusEntity}
          onScopeChange={scope => void handleScopeChange(scope)}
        />
      </div>
    </div>
  );
}

export default function HaystackManagementPage() {
  return (
    <Suspense fallback={<div className="p-6 text-[12px] text-gray-400">Loading…</div>}>
      <HaystackManagementBody />
    </Suspense>
  );
}
