'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CourtFilterRail } from '@/components/courts/court-filter-rail';
import { CourtTable } from '@/components/courts/court-table';
import { CourtPreviewPanel } from '@/components/courts/court-preview-panel';
import { CourtCreateModal } from '@/components/courts/court-create-modal';
import {
  listCourts,
  COURT_TYPES,
  type CourtType,
  type Court,
  CourtsApiError,
} from '@/lib/courts/client';

const PAGE_LIMIT = 100;

function parseType(v: string | null): CourtType | '' {
  if (!v) return '';
  return (COURT_TYPES as readonly string[]).includes(v) ? (v as CourtType) : '';
}

export default function CourtsPage() {
  // useSearchParams() must sit under a Suspense boundary or `next build`
  // bails out of static prerendering for this route (Next 15+/16). Wrap the
  // real page so the shell can prerender.
  return (
    <Suspense fallback={null}>
      <CourtsPageInner />
    </Suspense>
  );
}

function CourtsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const type = parseType(searchParams.get('type'));
  const q = searchParams.get('q') || '';
  const page = Math.max(0, parseInt(searchParams.get('page') || '0', 10) || 0);

  const [courts, setCourts] = useState<Court[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Court | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const updateUrl = useCallback(
    (next: { type?: CourtType | ''; q?: string; page?: number }) => {
      const params = new URLSearchParams();
      const nextType = next.type !== undefined ? next.type : type;
      const nextQ = next.q !== undefined ? next.q : q;
      const nextPage = next.page ?? page;
      if (nextType) params.set('type', nextType);
      if (nextQ) params.set('q', nextQ);
      if (nextPage > 0) params.set('page', String(nextPage));
      const qs = params.toString();
      router.replace(qs ? `/courts?${qs}` : '/courts');
    },
    [router, type, q, page],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listCourts({
      q,
      type: type || undefined,
      limit: PAGE_LIMIT,
      offset: page * PAGE_LIMIT,
    })
      .then((res) => {
        if (cancelled) return;
        setCourts(res.courts || []);
        setTotal(res.total ?? (res.courts || []).length);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof CourtsApiError && err.status === 404) {
          setError('Courts backend not yet available.');
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load courts');
        }
        setCourts([]);
        setTotal(0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [type, q, page]);

  const openDetail = (c: Court) => {
    router.push(`/courts/${encodeURIComponent(c.id)}`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  return (
    <div className="flex h-full">
      <CourtFilterRail
        type={type}
        q={q}
        onTypeChange={(t) => updateUrl({ type: t, page: 0 })}
        onQChange={(qq) => updateUrl({ q: qq, page: 0 })}
        totalCount={total}
      />

      <div className="flex-1 flex flex-col min-w-0 bg-white">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
          <h1 className="text-lg font-semibold text-gray-900">Courts</h1>
          <span className="text-xs text-gray-400">
            {total} {total === 1 ? 'court' : 'courts'}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-white bg-blue-600 rounded hover:bg-blue-700"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            New Court
          </button>
        </div>

        {(type || q) && (
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
                >
                  ×
                </button>
              </span>
            )}
            {type && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 text-green-800 border border-green-200 rounded-full capitalize">
                {type}
                <button
                  type="button"
                  className="text-green-700 hover:text-red-600"
                  onClick={() => updateUrl({ type: '', page: 0 })}
                  aria-label={`Clear ${type}`}
                >
                  ×
                </button>
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-800">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            Loading…
          </div>
        ) : (
          <CourtTable
            courts={courts}
            selectedId={selected?.id || null}
            onSelect={setSelected}
            onOpen={openDetail}
          />
        )}

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

      <CourtPreviewPanel court={selected} />

      <CourtCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(c) => {
          setCreateOpen(false);
          setCourts((cur) => [c, ...cur]);
          setSelected(c);
          setTotal((t) => t + 1);
        }}
      />
    </div>
  );
}
