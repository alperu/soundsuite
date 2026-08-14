'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnfiledDocument } from './types';

/**
 * The unfiled-documents panel: every document no filing claims, paged.
 *
 * These run to the hundreds per case, so the list is fetched a page at a time
 * from `GET /api/scope/unfiled` rather than riding along on the scope graph.
 * A row is dragged onto a filing block on the canvas to file it — the drop
 * handler on the canvas side reads `DOCUMENT_DRAG_TYPE` off the dataTransfer.
 */

/** Custom MIME so a row drag is never mistaken for the PDF droplet. */
export const DOCUMENT_DRAG_TYPE = 'application/x-soundsuite-document-id';

const PAGE_SIZE = 50;

interface Props {
  caseNameById: Map<string, string>;
  /** Bumped by the host after a file/unfile so the list refetches. */
  refreshKey: number;
  onDragStateChange?: (dragging: boolean) => void;
  /**
   * Set to list one filing's documents instead of the unfiled pile. That's the
   * only place a FILED document is visible, and therefore the only place it can
   * be sent back — the canvas shows a filing's document count, not its contents.
   */
  filingId?: string;
  filingLabel?: string;
  onUnfile?: (documentId: string) => void | Promise<void>;
}

interface Page {
  rows: UnfiledDocument[];
  total: number;
}

export function UnfiledPanel({
  caseNameById,
  refreshKey,
  onDragStateChange,
  filingId,
  filingLabel,
  onUnfile,
}: Props) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState<Page>({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (offset: number) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
        if (debounced) params.set('q', debounced);
        if (filingId) params.set('filingId', filingId);
        const path = filingId ? '/api/scope/filing-documents' : '/api/scope/unfiled';
        const res = await fetch(`${path}?${params.toString()}`);
        if (!res.ok) throw new Error(`${path} ${res.status}`);
        const body = (await res.json()) as { rows?: UnfiledDocument[]; total?: number };
        if (id !== requestId.current) return; // a newer search won
        setPage(prev => ({
          rows: offset === 0 ? body.rows ?? [] : [...prev.rows, ...(body.rows ?? [])],
          total: body.total ?? 0,
        }));
      } catch (err) {
        if (id !== requestId.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load documents');
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [debounced, filingId],
  );

  useEffect(() => {
    void load(0);
  }, [load, refreshKey]);

  const groups = useMemo(() => {
    const byCase = new Map<string, UnfiledDocument[]>();
    for (const row of page.rows) {
      const list = byCase.get(row.caseId) ?? [];
      list.push(row);
      byCase.set(row.caseId, list);
    }
    return Array.from(byCase.entries())
      .map(([caseId, rows]) => ({
        caseId,
        name: caseNameById.get(caseId) ?? 'Unknown case',
        rows,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [page.rows, caseNameById]);

  const hasMore = page.rows.length < page.total;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-gray-200 px-3 py-2">
        <div className="flex items-center justify-between">
          <h2 className="truncate text-xs font-semibold uppercase tracking-wider text-gray-500">
            {filingId ? 'Filing docs' : 'Unfiled docs'}
          </h2>
          <span className="text-[11px] tabular-nums text-gray-400">
            {page.rows.length} of {page.total}
          </span>
        </div>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search documents…"
          className="w-full rounded border border-gray-200 px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <p className="truncate text-[10px] text-gray-400">
          {filingId
            ? `Documents filed under ${filingLabel ?? 'this filing'} — Unfile sends one back.`
            : 'Drag a row onto a filing block to file it.'}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="px-3 py-4 text-[12px] text-red-600">{error}</p>}
        {!error && loading && page.rows.length === 0 && (
          <p className="px-3 py-4 text-[12px] text-gray-400">Loading documents…</p>
        )}
        {!error && !loading && page.rows.length === 0 && (
          <p className="px-3 py-4 text-[12px] text-gray-400">
            {debounced
              ? 'Nothing matches that search.'
              : filingId
                ? 'This filing has no documents yet.'
                : 'Every document is filed.'}
          </p>
        )}

        {groups.map(group => (
          <div key={group.caseId}>
            <div className="sticky top-0 z-10 flex items-center justify-between border-y border-gray-200 bg-gray-50 px-3 py-1.5">
              <span className="truncate text-[11px] font-semibold text-gray-600">{group.name}</span>
              <span className="text-[10px] tabular-nums text-gray-400">{group.rows.length}</span>
            </div>
            {group.rows.map(row => (
              <div
                key={row.id}
                draggable={!filingId}
                data-unfiled-id={filingId ? undefined : row.id}
                data-filed-id={filingId ? row.id : undefined}
                onDragStart={
                  filingId
                    ? undefined
                    : e => {
                        e.dataTransfer.setData(DOCUMENT_DRAG_TYPE, row.id);
                        e.dataTransfer.effectAllowed = 'link';
                        onDragStateChange?.(true);
                      }
                }
                onDragEnd={filingId ? undefined : () => onDragStateChange?.(false)}
                className={`border-b border-gray-100 px-3 py-2 transition-colors hover:bg-gray-50 ${
                  filingId ? '' : 'cursor-grab active:cursor-grabbing'
                }`}
              >
                <div className="truncate text-[12px] leading-snug text-gray-800">{row.label}</div>
                <div className="mt-1 flex items-center gap-1">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      row.status === 'INDEXED'
                        ? 'bg-emerald-50 text-emerald-700'
                        : row.status === 'ERROR'
                          ? 'bg-red-50 text-red-700'
                          : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {row.status.toLowerCase()}
                  </span>
                  {filingId && onUnfile && (
                    <button
                      onClick={() => void onUnfile(row.id)}
                      className="ml-auto rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-100"
                      title="Send this document back to the unfiled pile"
                    >
                      Unfile
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

        {hasMore && (
          <button
            onClick={() => void load(page.rows.length)}
            disabled={loading}
            className="w-full px-3 py-2 text-[11px] text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            {loading ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, page.total - page.rows.length)} more`}
          </button>
        )}
      </div>
    </div>
  );
}
