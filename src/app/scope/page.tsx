'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import { HaystackBlockView } from '@/components/haystack-block-view/haystack-block-view';
import type { ScopeSelection } from '@/components/haystack-block-view/types';
import { setPreference } from '@/lib/indexed-db';

/**
 * Full-page host for the Haystack Block View: whole-corpus scope, editable.
 * `?tab=editor` opens straight into the mapping workbench.
 * `?case=<id>` narrows to one case (case-management entry points).
 * `?focus=<kind>:<id>` preselects an entity in the Editor worklist.
 */
function ScopePageBody() {
  const params = useSearchParams();
  const initialTab = params.get('tab') === 'editor' ? 'editor' : 'filtering';
  const caseId = params.get('case');
  const focusRaw = params.get('focus');
  const focusEntity = (() => {
    if (!focusRaw) return undefined;
    const sep = focusRaw.indexOf(':');
    if (sep <= 0 || sep === focusRaw.length - 1) return undefined;
    return { kind: focusRaw.slice(0, sep), id: focusRaw.slice(sep + 1) };
  })();

  /**
   * Persist to the same keys the search UI reads (`search.scopeSet` +
   * `search.scopeSetActive`). An empty selection is the "Clear scope" signal:
   * the set stays on disk, but search stops applying it.
   */
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
        <Link
          href="/"
          className="text-[12px] text-gray-500 hover:text-blue-600 transition-colors"
        >
          ← Back
        </Link>
        <h1 className="text-sm font-semibold text-gray-800">Haystack Block View</h1>
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

export default function ScopePage() {
  return (
    <Suspense fallback={<div className="p-6 text-[12px] text-gray-400">Loading…</div>}>
      <ScopePageBody />
    </Suspense>
  );
}
