'use client';

/**
 * ChunkPreviewGrid — right-panel grid that shows DOCUMENT-CHUNK matches for
 * the current composer filter. Replaces the old HaystackPreviewGrid which
 * could only query one entity table at a time (Case, Motion, etc.) and
 * therefore choked on chip filters that crossed columns
 * (`case==@A and filingRef==@F`).
 *
 * This grid sends the full compiled filter string to `/api/search/unified`,
 * which runs the same boolean-query → AST → SQL-prefilter → LanceDB pipeline
 * the real search uses. Rows are chunks; columns are document title, case,
 * filing, page, snippet, score.
 */

import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Compiled Axon-flavored boolean query (the filter string produced by
   *  `buildHaystackFilter`). Empty/whitespace renders an idle state. */
  filter: string;
  /** Optional freetext appended to the filter for ranking. */
  freetext?: string;
  /** Hidden by parent — e.g. when the user is editing chips. */
  disabled?: boolean;
}

interface ChunkRow {
  id?: string;
  documentId?: string;
  document_id?: string;
  documentTitle?: string;
  caseId?: string;
  case_id?: string;
  filingId?: string;
  filing_id?: string;
  pageNumber?: number | string;
  page_number?: number | string;
  chunkIndex?: number | string;
  chunk_index?: number | string;
  text?: string;
  content?: string;
  score?: number;
  // We accept arbitrary extra fields so future schema changes don't break.
  [k: string]: unknown;
}

function cell(row: ChunkRow, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v == null) continue;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function shortId(v: string | undefined): string {
  if (!v) return '';
  return v.length > 12 ? v.slice(0, 8) + '…' : v;
}

export function ChunkPreviewGrid({ filter, freetext = '', disabled }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ChunkRow[]>([]);
  const [total, setTotal] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const trimmedFilter = (filter ?? '').trim();
  const idle = !trimmedFilter || disabled;

  useEffect(() => {
    if (idle) {
      setRows([]);
      setError(null);
      setTotal(0);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);

    // The unified route accepts a single `query` string. We compose:
    //   `<filter> <freetext>`  (freetext is appended for vector ranking)
    const composed = freetext.trim()
      ? `${trimmedFilter} ${freetext.trim()}`
      : trimmedFilter;

    void (async () => {
      try {
        // Lightweight SQL-only endpoint: no embedding, no reranker. Returns
        // chunks matching the structured filter in tens of milliseconds.
        const res = await fetch('/api/search/chunk-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter: trimmedFilter, limit: 30 }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const txt = await res.text();
          setError(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
          setRows([]);
          setLoading(false);
          return;
        }
        const json = (await res.json()) as { rows?: ChunkRow[]; total?: number; where?: string; error?: string };
        if (json.error) {
          setError(json.error);
          setRows(json.rows ?? []);
        } else {
          setRows(json.rows ?? []);
        }
        setTotal(json.total ?? json.rows?.length ?? 0);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [trimmedFilter, freetext, idle]);

  if (idle) {
    return (
      <div className="px-4 py-6 text-xs text-gray-400 italic">
        Build a filter in the composer or hover a chip to preview matching documents.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-3 py-1.5 text-[11px] text-gray-600 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <span>
          <span className="font-medium">{loading ? 'Searching…' : `${total} match${total === 1 ? '' : 'es'}`}</span>
          <span className="ml-2 text-gray-400">·</span>
          <code className="ml-2 font-mono text-[10px] text-purple-700 truncate inline-block max-w-[28rem] align-middle">
            {trimmedFilter}
          </code>
        </span>
        {loading && <span className="inline-block w-3 h-3 rounded-full border-2 border-purple-300 border-t-purple-700 animate-spin" />}
      </div>
      {error && (
        <div className="px-3 py-2 text-[11px] text-red-700 bg-red-50 border-b border-red-200">
          {error}
        </div>
      )}
      {!loading && rows.length === 0 && !error && (
        <div className="px-4 py-6 text-xs text-gray-500 italic">
          No documents matched. Try widening the filter or removing constraints.
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 240px)' }}>
          <table className="min-w-full text-[11px]">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium text-gray-600">Document</th>
                <th className="text-left px-2 py-1.5 font-medium text-gray-600">Case</th>
                <th className="text-left px-2 py-1.5 font-medium text-gray-600">Filing</th>
                <th className="text-right px-2 py-1.5 font-medium text-gray-600">Pg</th>
                <th className="text-left px-2 py-1.5 font-medium text-gray-600">Snippet</th>
                <th className="text-right px-2 py-1.5 font-medium text-gray-600">Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const docTitle = cell(row, 'documentTitle', 'document_title', 'fileName', 'file_name') || shortId(cell(row, 'documentId', 'document_id'));
                const caseLabel = cell(row, 'caseName', 'case_name', 'caseNumber', 'case_number') || shortId(cell(row, 'caseId', 'case_id'));
                const filingLabel = cell(row, 'filingTitle', 'filing_title', 'filingType', 'filing_type') || shortId(cell(row, 'filingId', 'filing_id'));
                const page = cell(row, 'pageNumber', 'page_number');
                const snippet = (cell(row, 'text', 'content') || '').slice(0, 200);
                const score = row.score;
                return (
                  <tr key={`${i}-${row.id ?? row.documentId ?? ''}`} className="border-b border-gray-100 hover:bg-purple-50/40">
                    <td className="px-2 py-1.5 align-top text-gray-800 max-w-[14rem] truncate" title={docTitle}>{docTitle}</td>
                    <td className="px-2 py-1.5 align-top text-gray-600 max-w-[10rem] truncate" title={caseLabel}>{caseLabel}</td>
                    <td className="px-2 py-1.5 align-top text-gray-600 max-w-[10rem] truncate" title={filingLabel}>{filingLabel}</td>
                    <td className="px-2 py-1.5 align-top text-right text-gray-500 tabular-nums">{page}</td>
                    <td className="px-2 py-1.5 align-top text-gray-700 max-w-[24rem] truncate" title={snippet}>{snippet}</td>
                    <td className="px-2 py-1.5 align-top text-right text-gray-500 tabular-nums">
                      {typeof score === 'number' ? score.toFixed(3) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default ChunkPreviewGrid;
