'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import { getPreference } from '@/lib/indexed-db';
import { buildScopeGraph } from './scope-graph';
import type { CanvasTool } from './block-canvas';
import type { ScopeCase, ScopeSelection } from './types';
import { useScopeSelection } from './use-scope-selection';

/** Rete touches `document` on construction — client only, and at module scope
 *  so a selection re-render never remounts the canvas. */
const BlockCanvas = dynamic(() => import('./block-canvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[12px] text-gray-400">
      Loading canvas…
    </div>
  ),
});

interface Props {
  /** Already narrowed to the host's scope by HaystackBlockView. */
  cases: ScopeCase[];
  unconnectedCount: number;
  loading: boolean;
  /** Filtering → host. "Apply scope" fires this with the compiled selection;
   *  "Clear scope" fires it with empty arrays. */
  onScopeChange?: (scope: ScopeSelection) => void;
  /** Jump to the Editor tab; undefined in read-only hosts. */
  onEditUnconnected?: () => void;
}

/**
 * Filtering tab — the block canvas plus its toolbar.
 *
 * Selection lives here (`useScopeSelection`) and the canvas only paints it, so
 * the rete plugins never own domain state. "Clear" empties the canvas
 * selection; only "Apply scope" / "Clear scope" reach the host and therefore
 * the persisted `search.scopeSet`.
 */
export function FilteringTab({
  cases,
  unconnectedCount,
  loading,
  onScopeChange,
  onEditUnconnected,
}: Props) {
  const graph = useMemo(() => buildScopeGraph(cases), [cases]);
  const {
    selected,
    toggleCase,
    toggleFiling,
    toggleFilingBare,
    selectArea,
    selectAll,
    clear,
    selection,
    totals,
  } = useScopeSelection(graph);

  /** Which gesture the left button performs on the canvas. */
  const [tool, setTool] = useState<CanvasTool>('pointer');

  const [scopeActive, setScopeActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getPreference<boolean>('search.scopeSetActive').then(value => {
      if (alive) setScopeActive(Boolean(value));
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  // Ctrl/Cmd narrows to the one block clicked. A case block has no bare form —
  // its key is a rollup of its children — so it always cascades.
  const onToggle = (key: string, bare = false) => {
    if (key.startsWith('case:')) toggleCase(key);
    else if (bare) toggleFilingBare(key);
    else toggleFiling(key);
  };

  const applyScope = () => {
    onScopeChange?.(selection);
    setScopeActive(true);
    setToast(
      `Scope applied — ${totals.filings} filings across ${totals.cases} cases`,
    );
  };

  const clearScope = () => {
    onScopeChange?.({ caseIds: [], filingIds: [] });
    setScopeActive(false);
    setToast('Scope cleared — search covers the whole corpus');
  };

  const hasSelection = totals.filings > 0 || selection.caseIds.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50/70 px-3 py-2 flex-shrink-0">
        {/* Tool picker. Marquee is the only alternative to the pointer for
            now; the lasso would join it here. */}
        <div className="flex overflow-hidden rounded border border-gray-300">
          {(['pointer', 'marquee'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTool(t)}
              title={
                t === 'pointer'
                  ? 'Pointer — click blocks to select (Ctrl/Cmd for one block only)'
                  : 'Marquee — drag a box. Left-to-right takes what it fully encloses, right-to-left takes anything it touches; hold Shift to remove.'
              }
              aria-pressed={tool === t}
              className={`px-2 py-1 text-[11px] capitalize ${
                tool === t ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <button
          onClick={selectAll}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-100"
        >
          Select all
        </button>
        <button
          onClick={clear}
          disabled={!hasSelection}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-100 disabled:opacity-40"
        >
          Clear
        </button>

        <span className="ml-1 text-[11px] text-gray-600">
          {totals.filings} filings across {totals.cases} cases · {totals.indexedDocs} indexed
          docs in scope
        </span>

        {scopeActive && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            scope active
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {onEditUnconnected && unconnectedCount > 0 && (
            <button
              onClick={onEditUnconnected}
              className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800 hover:bg-amber-100"
            >
              unmapped: {unconnectedCount} → Edit
            </button>
          )}
          <button
            onClick={applyScope}
            disabled={!hasSelection}
            className="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            Apply scope
          </button>
          <button
            onClick={clearScope}
            className="rounded border border-gray-300 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-100"
          >
            Clear scope
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="relative flex-1 min-h-0 bg-[radial-gradient(circle,rgba(0,0,0,0.06)_1px,transparent_1px)] [background-size:18px_18px]">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[12px] text-gray-400">
            Loading scope…
          </div>
        ) : graph.cases.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-gray-400">
            No cases in this scope.
          </div>
        ) : (
          <BlockCanvas
            mode="filter"
            graph={graph}
            selected={selected}
            onToggle={onToggle}
            onBackgroundClick={clear}
            tool={tool}
            onMarquee={result => selectArea(result.ids, result.subtract)}
          />
        )}

        {toast && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-gray-900/90 px-3 py-1.5 text-[11px] text-white shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
