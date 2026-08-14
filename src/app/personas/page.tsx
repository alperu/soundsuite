'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PersonaFilterRail } from '@/components/personas/persona-filter-rail';
import { PersonaTable } from '@/components/personas/persona-table';
import { PersonaPreviewPanel } from '@/components/personas/persona-preview-panel';
import { PersonaCreateModal } from '@/components/personas/persona-create-modal';
import {
  listPersonas,
  INTRINSIC_MARKERS,
  type IntrinsicMarker,
  type Persona,
  PersonasApiError,
} from '@/lib/personas/client';

import { ExtractModal } from '@/components/personas/extract-modal';
const EXTRACT_MODAL_AVAILABLE = true;

const PAGE_LIMIT = 50;

function parseTags(values: string[] | string | null): IntrinsicMarker[] {
  if (!values) return [];
  const arr = Array.isArray(values) ? values : [values];
  const valid = new Set<string>(INTRINSIC_MARKERS);
  return arr.filter((v): v is IntrinsicMarker => valid.has(v));
}

export default function PersonasPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tags = parseTags(searchParams.getAll('tag'));
  const q = searchParams.get('q') || '';
  const page = Math.max(0, parseInt(searchParams.get('page') || '0', 10) || 0);

  const [personas, setPersonas] = useState<Persona[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Persona | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);

  // Sync URL params helper
  const updateUrl = useCallback((next: { tags?: IntrinsicMarker[]; q?: string; page?: number }) => {
    const params = new URLSearchParams();
    const nextTags = next.tags ?? tags;
    const nextQ = next.q ?? q;
    const nextPage = next.page ?? page;
    for (const t of nextTags) params.append('tag', t);
    if (nextQ) params.set('q', nextQ);
    if (nextPage > 0) params.set('page', String(nextPage));
    const qs = params.toString();
    router.replace(qs ? `/personas?${qs}` : '/personas');
  }, [router, tags, q, page]);

  // Load on filter/page change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listPersonas({ tags, q, limit: PAGE_LIMIT, offset: page * PAGE_LIMIT })
      .then((res) => {
        if (cancelled) return;
        setPersonas(res.personas || []);
        setTotal(res.total ?? (res.personas || []).length);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof PersonasApiError && err.status === 404) {
          setError('Personas backend not yet available. UI is wired and ready.');
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load personas');
        }
        setPersonas([]);
        setTotal(0);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(tags), q, page]);

  const openDetail = (p: Persona) => {
    router.push(`/personas/${encodeURIComponent(p.id)}`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  return (
    <div className="flex h-full">
      <PersonaFilterRail
        tags={tags}
        q={q}
        onTagsChange={(t) => updateUrl({ tags: t, page: 0 })}
        onQChange={(qq) => updateUrl({ q: qq, page: 0 })}
        totalCount={total}
      />

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0 bg-white">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
          <h1 className="text-lg font-semibold text-gray-900">Personas</h1>
          <span className="text-xs text-gray-400">
            {total} {total === 1 ? 'persona' : 'personas'}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => {
              if (EXTRACT_MODAL_AVAILABLE) {
                setExtractOpen(true);
              } else {
                 
                console.log('[TODO] Extract modal — Agent C delivers <ExtractModal /> @/components/personas/extract-modal');
                alert('Extract-from-file modal is delivered by Agent C. Stub for now.');
              }
            }}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Extract from file
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Persona
          </button>
        </div>

        {/* Active filter chips */}
        {(tags.length > 0 || q) && (
          <div className="px-4 py-1.5 border-b border-gray-100 bg-gray-50 flex flex-wrap items-center gap-1 text-[11px] text-gray-600">
            <span className="text-gray-400 uppercase tracking-wider mr-1">Filters:</span>
            {q && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-gray-200 rounded-full">
                q: <span className="font-mono">{q}</span>
                <button
                  type="button"
                  className="text-gray-400 hover:text-red-600"
                  onClick={() => updateUrl({ q: '', page: 0 })}
                  aria-label="Clear search"
                >×</button>
              </span>
            )}
            {tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 text-green-800 border border-green-200 rounded-full">
                {t}
                <button
                  type="button"
                  className="text-green-700 hover:text-red-600"
                  onClick={() => updateUrl({ tags: tags.filter(x => x !== t), page: 0 })}
                  aria-label={`Remove ${t}`}
                >×</button>
              </span>
            ))}
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-800">
            {error}
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Loading…</div>
        ) : (
          <PersonaTable
            personas={personas}
            selectedId={selected?.id || null}
            onSelect={setSelected}
            onOpen={openDetail}
          />
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-2 border-t border-gray-200 flex items-center justify-between text-xs">
            <span className="text-gray-500">
              Page {page + 1} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => updateUrl({ page: page - 1 })}
                className="px-2 py-1 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={page + 1 >= totalPages}
                onClick={() => updateUrl({ page: page + 1 })}
                className="px-2 py-1 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Preview rail */}
      <PersonaPreviewPanel persona={selected} />

      {/* Create modal */}
      <PersonaCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(p) => {
          setCreateOpen(false);
          // Optimistically prepend; refetch will reconcile
          setPersonas((cur) => [p, ...cur]);
          setSelected(p);
        }}
      />

      {/*
        // Once Agent C ships:
        // EXTRACT_MODAL_AVAILABLE && extractOpen && (
        //   <ExtractModal
        //     open={extractOpen}
        //     onClose={() => setExtractOpen(false)}
        //   />
        // )
      */}
      {extractOpen && null}
    </div>
  );
}
