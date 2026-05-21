'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExtractProgress } from './extract-progress';
import { ExtractCandidateCard } from './extract-candidate-card';
import { ExtractManualForm, type ManualPersonaRow } from './extract-manual-form';
import { NEW_PERSONA_VALUE } from './extract-dedup-picker';
import type {
  DocumentSummary,
  ExtractCandidate,
  ExtractResponse,
  ExtractResult,
  ModalState,
} from './extract-types';

interface Props {
  open: boolean;
  onClose(): void;
  onConfirmed(result: ExtractResult): void;
  defaultDocumentId?: string;
  /** When set, skip the file picker and extract across every Document linked
   * to this Motion (via MotionAttachment). Server merges candidates with dedup
   * and pre-scopes proposed role bindings to the motion. */
  defaultMotionId?: string;
  /** Optional human-readable label shown in the modal header when motion is pre-selected. */
  defaultMotionLabel?: string;
  /** Test-only: force initial state and pre-populate candidates. */
  defaultState?: ModalState;
  defaultCandidates?: ExtractCandidate[];
}

/**
 * Review-queue modal: turns LanceDB/regex extraction output into confirmed
 * Persona + PersonRole records.
 *
 * Walks the user through:
 *   picking → extracting → reviewing → success
 *                      ↘ manual-fallback → success
 *
 * Backend endpoints consumed (all owned by other agents — stubbed if 404):
 *   GET  /api/documents?q=...                 — typeahead
 *   POST /api/personas/extract                — kick off extraction
 *   POST /api/personas/extract/bulk-confirm   — commit confirmed cards
 *   POST /api/personas/admin/manual-define    — manual fallback
 */
export function ExtractModal({
  open,
  onClose,
  onConfirmed,
  defaultDocumentId,
  defaultMotionId,
  defaultMotionLabel,
  defaultState,
  defaultCandidates,
}: Props) {
  const [state, setState] = useState<ModalState>(defaultState ?? 'picking');
  const [tab, setTab] = useState<'ingested' | 'upload'>('ingested');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DocumentSummary[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocumentSummary | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [stagesRun, setStagesRun] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<ExtractCandidate[]>(defaultCandidates ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [successResult, setSuccessResult] = useState<ExtractResult | null>(null);

  // Reset when opened/closed
  useEffect(() => {
    if (!open) return;
    setState(defaultState ?? 'picking');
    setExtractError(null);
    setSuccessResult(null);
    setSubmitting(false);
    if (defaultCandidates) setCandidates(defaultCandidates);
    if (defaultMotionId && !defaultState) {
      // Auto-extract every document attached to the motion in one batch.
      setSelectedDoc({
        id: `motion:${defaultMotionId}`,
        fileName: defaultMotionLabel ?? '(motion documents)',
      });
      void startExtract({ motionId: defaultMotionId });
    } else if (defaultDocumentId && !defaultState) {
      // Auto-extract if document pre-selected
      setSelectedDoc({ id: defaultDocumentId, fileName: '(pre-selected)' });
      void startExtract({ documentId: defaultDocumentId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Typeahead against /api/documents?q=
  useEffect(() => {
    if (!open || tab !== 'ingested') return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const url = query.trim()
          ? `/api/documents?q=${encodeURIComponent(query)}`
          : '/api/documents';
        const r = await fetch(url);
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const docs: DocumentSummary[] = Array.isArray(data?.documents)
          ? data.documents.map((d: Record<string, unknown>) => ({
              id: String(d.id),
              fileName: String(d.fileName ?? d.name ?? 'document'),
              caseLabel: typeof d.caseLabel === 'string' ? d.caseLabel : undefined,
              filingLabel: typeof d.filingLabel === 'string' ? d.filingLabel : undefined,
            }))
          : [];
        setResults(docs.slice(0, 10));
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open, tab]);

  const startExtract = useCallback(async (target: { documentId?: string; motionId?: string }) => {
    setState('extracting');
    setExtractError(null);
    setStagesRun([]);
    try {
      const r = await fetch('/api/personas/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      if (!r.ok) {
        throw new Error(`Extraction failed (HTTP ${r.status})`);
      }
      const data = (await r.json()) as ExtractResponse;
      setStagesRun(data.stagesRun ?? []);
      const enriched = (data.candidates ?? []).map((c, idx) => ({
        ...c,
        id: c.id ?? `cand-${idx}`,
        confirmed: true,
        dedupChoice:
          c.dedupMatches?.[0]?.personaId ?? NEW_PERSONA_VALUE,
      }));
      setCandidates(enriched);
      if (enriched.length > 0) {
        setState('reviewing');
      } else if (data.recommendation === 'manual') {
        setState('manual-fallback');
      } else {
        setState('manual-fallback');
      }
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Extraction failed');
      setState('picking');
    }
  }, []);

  const confirmedCards = useMemo(
    () => candidates.filter(c => c.confirmed !== false),
    [candidates],
  );

  const handleBulkConfirm = async () => {
    if (!selectedDoc) return;
    setSubmitting(true);
    try {
      const payload = {
        documentId: selectedDoc.id,
        candidates: confirmedCards.map(c => ({
          displayName: c.displayName,
          barNumber: c.barNumber,
          email: c.email,
          intrinsicTags: c.intrinsicTags,
          mergeWithPersonaId:
            c.dedupChoice && c.dedupChoice !== NEW_PERSONA_VALUE
              ? c.dedupChoice
              : null,
          proposedRole: c.proposedRole,
          sourceChunkId: c.sourceChunkId,
        })),
      };
      const r = await fetch('/api/personas/extract/bulk-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`Bulk confirm failed (HTTP ${r.status})`);
      const data = (await r.json()) as ExtractResult;
      setSuccessResult({
        created: data.created ?? 0,
        updated: data.updated ?? 0,
        rolesAdded: data.rolesAdded ?? 0,
      });
      setState('success');
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Confirm failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleManualSubmit = async (rows: ManualPersonaRow[]) => {
    setSubmitting(true);
    try {
      const r = await fetch('/api/personas/admin/manual-define', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: selectedDoc?.id,
          candidates: rows,
        }),
      });
      if (!r.ok) throw new Error(`Manual define failed (HTTP ${r.status})`);
      const data = (await r.json()) as ExtractResult;
      setSuccessResult({
        created: data.created ?? rows.length,
        updated: data.updated ?? 0,
        rolesAdded: data.rolesAdded ?? 0,
      });
      setState('success');
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Manual define failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Extract Personas from file"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="bg-white w-full max-w-[720px] max-h-[90vh] rounded-xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-800">
            Extract Personas from file
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-700 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {extractError && (
            <div className="mb-4 p-2 text-xs bg-red-50 border border-red-200 rounded text-red-700">
              {extractError}
            </div>
          )}

          {state === 'picking' && (
            <PickingPane
              tab={tab}
              setTab={setTab}
              query={query}
              setQuery={setQuery}
              results={results}
              onPick={doc => {
                setSelectedDoc(doc);
                void startExtract({ documentId: doc.id });
              }}
            />
          )}

          {state === 'extracting' && <ExtractProgress stages={stagesRun} />}

          {state === 'reviewing' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-700">
                We found <span className="font-semibold">{candidates.length}</span>{' '}
                {candidates.length === 1 ? 'candidate' : 'candidates'} in{' '}
                <span className="font-medium">{selectedDoc?.fileName}</span>.
                Confirm or edit before saving.
              </p>
              <div className="space-y-3">
                {candidates.map(c => (
                  <ExtractCandidateCard
                    key={c.id}
                    candidate={c}
                    onChange={next =>
                      setCandidates(cs => cs.map(x => (x.id === c.id ? next : x)))
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {state === 'manual-fallback' && (
            <ExtractManualForm
              documentId={selectedDoc?.id}
              onSubmit={handleManualSubmit}
              onCancel={onClose}
              submitting={submitting}
            />
          )}

          {state === 'success' && successResult && (
            <div className="py-8 text-center space-y-3">
              <div className="text-3xl">✓</div>
              <div className="text-sm text-gray-700">
                Created{' '}
                <span className="font-semibold">{successResult.created}</span>{' '}
                {successResult.created === 1 ? 'Persona' : 'Personas'},
                updated <span className="font-semibold">{successResult.updated}</span>,
                added{' '}
                <span className="font-semibold">{successResult.rolesAdded}</span>{' '}
                role {successResult.rolesAdded === 1 ? 'binding' : 'bindings'}.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {state === 'reviewing' && (
          <div className="flex justify-between items-center px-5 py-3 border-t border-gray-200">
            <div className="text-xs text-gray-500">
              {confirmedCards.length} of {candidates.length} confirmed
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={confirmedCards.length === 0 || submitting}
                onClick={handleBulkConfirm}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Saving…' : `Confirm all (${confirmedCards.length})`}
              </button>
            </div>
          </div>
        )}

        {state === 'success' && successResult && (
          <div className="flex justify-end px-5 py-3 border-t border-gray-200">
            <button
              type="button"
              onClick={() => {
                onConfirmed(successResult);
                onClose();
              }}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface PickingPaneProps {
  tab: 'ingested' | 'upload';
  setTab(t: 'ingested' | 'upload'): void;
  query: string;
  setQuery(q: string): void;
  results: DocumentSummary[];
  onPick(doc: DocumentSummary): void;
}

function PickingPane({ tab, setTab, query, setQuery, results, onPick }: PickingPaneProps) {
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'ingested'}
          type="button"
          onClick={() => setTab('ingested')}
          className={
            'px-3 py-1.5 text-sm border-b-2 -mb-px ' +
            (tab === 'ingested'
              ? 'border-blue-600 text-blue-700 font-medium'
              : 'border-transparent text-gray-600 hover:text-gray-800')
          }
        >
          From ingested document
        </button>
        <button
          role="tab"
          aria-selected={tab === 'upload'}
          type="button"
          onClick={() => setTab('upload')}
          className={
            'px-3 py-1.5 text-sm border-b-2 -mb-px ' +
            (tab === 'upload'
              ? 'border-blue-600 text-blue-700 font-medium'
              : 'border-transparent text-gray-600 hover:text-gray-800')
          }
        >
          Upload new PDF
        </button>
      </div>

      <p className="text-xs text-gray-500">
        We&apos;ll scan the file for attorneys, judges, parties, clerks, and
        court reporters.
      </p>

      {tab === 'ingested' && (
        <div className="space-y-2">
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search ingested documents…"
            aria-label="Search ingested documents"
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          />
          <div className="border border-gray-200 rounded divide-y divide-gray-100 max-h-72 overflow-y-auto">
            {results.length === 0 && (
              <div className="px-3 py-6 text-xs text-gray-400 text-center">
                No documents match.
              </div>
            )}
            {results.map(d => (
              <button
                key={d.id}
                type="button"
                onClick={() => onPick(d)}
                className="w-full text-left px-3 py-2 hover:bg-blue-50 text-sm"
              >
                <div className="font-medium text-gray-800">{d.fileName}</div>
                {(d.caseLabel || d.filingLabel) && (
                  <div className="text-xs text-gray-500">
                    {[d.caseLabel, d.filingLabel].filter(Boolean).join(' • ')}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'upload' && (
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
          <p className="text-sm text-gray-600 mb-2">
            To upload a new PDF, please use the case-management uploader.
          </p>
          <a
            href="/case-management"
            className="text-sm text-blue-600 hover:underline"
          >
            Go to Case Management →
          </a>
        </div>
      )}
    </div>
  );
}
