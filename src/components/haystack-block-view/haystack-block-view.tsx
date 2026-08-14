'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorTab } from './editor-tab';
import { FilteringTab } from './filtering-tab';
import type { ScopeCase, ScopeSelection, UnconnectedRow } from './types';

export type BlockViewTab = 'filtering' | 'editor';

interface Props {
  scope: { kind: 'case'; caseId: string } | { kind: 'all' };
  initialTab?: BlockViewTab;
  /** Filtering-only hosts: the Editor tab is not rendered at all. */
  readOnly?: boolean;
  /** Editor opens preselected on this row. */
  focusEntity?: { kind: string; id: string };
  onScopeChange?: (scope: ScopeSelection) => void;
}

/**
 * Haystack Block View — the scope workbench.
 *
 * Two tabs over one shared data load: "Filtering" (the block canvas, task #29)
 * and "Editor" (the unconnected worklist + an embedded TagPanel). Both read
 * `GET /api/scope/graph` and `GET /api/scope/unconnected`; a TagPanel save
 * fires the global `entity-updated` event, which refetches both here so the
 * canvas and the worklist agree on connectivity without a page reload.
 */
export function HaystackBlockView({
  scope,
  initialTab = 'filtering',
  readOnly,
  focusEntity,
  onScopeChange,
}: Props) {
  const [tab, setTab] = useState<BlockViewTab>(
    readOnly && initialTab === 'editor' ? 'filtering' : initialTab,
  );
  const [cases, setCases] = useState<ScopeCase[]>([]);
  const [unconnected, setUnconnected] = useState<UnconnectedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const scopeCaseId = scope.kind === 'case' ? scope.caseId : null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [graphRes, unconnectedRes] = await Promise.all([
        fetch('/api/scope/graph'),
        fetch('/api/scope/unconnected'),
      ]);
      if (!graphRes.ok) throw new Error(`scope/graph ${graphRes.status}`);
      if (!unconnectedRes.ok) throw new Error(`scope/unconnected ${unconnectedRes.status}`);
      const graph = (await graphRes.json()) as { cases?: ScopeCase[] };
      const work = (await unconnectedRes.json()) as { rows?: UnconnectedRow[] };
      setCases(graph.cases ?? []);
      setUnconnected(work.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scope data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A TagPanel save (or any other edge write) announces itself globally.
  // Debounced: a multi-slot save can emit more than once in quick succession.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const handler = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => { void load(); }, 400);
    };
    window.addEventListener('entity-updated', handler);
    window.addEventListener('filings-changed', handler);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      window.removeEventListener('entity-updated', handler);
      window.removeEventListener('filings-changed', handler);
    };
  }, [load]);

  const scopedCases = useMemo(
    () => (scopeCaseId ? cases.filter(c => c.id === scopeCaseId) : cases),
    [cases, scopeCaseId],
  );
  const scopedUnconnected = useMemo(
    () => (scopeCaseId ? unconnected.filter(r => r.caseId === scopeCaseId) : unconnected),
    [unconnected, scopeCaseId],
  );

  // Worklist entries, not raw rows: a shadow Motion and its MotionAttachment
  // share one entity id and collapse into a single Editor row.
  const unconnectedCount = useMemo(
    () => new Set(scopedUnconnected.map(r => r.entityId)).size,
    [scopedUnconnected],
  );

  const caseNameById = useMemo(
    () => new Map(scopedCases.map(c => [c.id, c.name])),
    [scopedCases],
  );
  // Worklist rows carry only an entityKind; the filing type chip lives on the
  // graph payload.
  const filingTypeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of scopedCases) {
      for (const f of c.filings) map.set(f.id, f.filingType);
    }
    return map;
  }, [scopedCases]);

  const tabs: BlockViewTab[] = readOnly ? ['filtering'] : ['filtering', 'editor'];

  return (
    <div className="flex flex-col h-full min-h-0 bg-white">
      {/* Tabs */}
      <div className="flex border-b border-gray-200 flex-shrink-0">
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2.5 text-[12px] font-medium transition-colors ${
              tab === t
                ? 'text-blue-700 border-b-2 border-blue-600 bg-blue-50/50'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
          >
            {t === 'filtering' ? 'Filtering' : 'Editor'}
          </button>
        ))}
        <div className="flex-1 flex items-center justify-end px-3 text-[11px] text-gray-400">
          {loading
            ? 'Loading scope…'
            : error
              ? <span className="text-red-600">{error}</span>
              : `${unconnectedCount} unconnected`}
        </div>
      </div>

      {/* Tab body */}
      <div className="flex-1 min-h-0">
        {tab === 'filtering' ? (
          <FilteringTab
            cases={scopedCases}
            unconnectedCount={unconnectedCount}
            loading={loading}
            onScopeChange={onScopeChange}
            onEditUnconnected={readOnly ? undefined : () => setTab('editor')}
          />
        ) : (
          <EditorTab
            rows={scopedUnconnected}
            cases={scopedCases}
            caseNameById={caseNameById}
            filingTypeById={filingTypeById}
            loading={loading}
            focusEntity={focusEntity}
          />
        )}
      </div>
    </div>
  );
}
