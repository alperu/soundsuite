/**
 * TagFillReviewPanel — slide-over panel for reviewing AI-suggested haystack
 * tag fills before committing them, and for reverting recent applied fills.
 *
 * Mounted by the case-management page when a `haystack-tags-suggestions`
 * CustomEvent fires with a non-empty suggestions array. The panel does NOT
 * run the extractor; it only consumes the response shape defined by
 * Agent E in `/api/cases/[id]/fill-haystack-tags/route.ts`.
 *
 * Two views:
 *  1. "Suggestions"  — checkbox list per filing/field with diff + confidence.
 *                      "Apply N accepted" POSTs `{dryRun:false, accept:[...]}`.
 *  2. "Recent fills" — secondary view listing ActionLog entries with
 *                      logType='tag-fill', most recent 50, scoped by caseId.
 *                      Each entry has a "Revert" button → POST .../revert.
 *
 * No new schema. Recent-fills view reads `ActionLog.detail` as JSON (shape
 * matches the contract in /revert/route.ts). Idempotency on revert: a
 * 400 `already_reverted` from the server is treated as a no-op success in
 * the UI (the row's status flips to 'reverted' and the button disables).
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  FillTagSuggestion,
  FillTagsResponse,
  HaystackTagField,
} from '@/app/api/cases/[id]/fill-haystack-tags/route';

// ────────────────────────────────────────────────────────────────────────────
// Props
// ────────────────────────────────────────────────────────────────────────────

export interface TagFillReviewPanelProps {
  caseId: string;
  suggestions: FillTagSuggestion[];
  /** Optional note from the extractor (e.g. "Phase-1 stub"). */
  note?: string;
  /** Number of filings the extractor scanned. */
  scanned?: number;
  /** Called when the user closes the panel or clicks "Cancel". */
  onClose(): void;
  /** Called after a successful apply so the parent can refresh state. */
  onApplied?(result: { accepted: number }): void;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Lightweight Hayson `@ref` shape. The real ref type is wider; we narrow defensively. */
interface MaybeRef {
  _kind?: string;
  val?: string;
  dis?: string;
}

function isRef(v: unknown): v is MaybeRef {
  return (
    v != null &&
    typeof v === 'object' &&
    (v as MaybeRef)._kind === 'ref' &&
    typeof (v as MaybeRef).val === 'string'
  );
}

function shortRefId(val: string): string {
  if (!val) return '';
  if (val.length <= 10) return val;
  return `${val.slice(0, 8)}…`;
}

function formatValue(v: unknown, fallbackDisplay?: string): string {
  if (v == null || v === '') return '—';
  if (isRef(v)) {
    const dis = fallbackDisplay ?? v.dis;
    if (dis && dis.trim()) return dis;
    return `${shortRefId(v.val ?? '')}...`;
  }
  if (typeof v === 'string') {
    // ISO date detection — trim time portion if present.
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function confidencePill(c: FillTagSuggestion['confidence']) {
  if (c === 'high') return 'bg-green-100 text-green-800 border-green-200';
  if (c === 'medium') return 'bg-yellow-100 text-yellow-800 border-yellow-200';
  return 'bg-gray-100 text-gray-600 border-gray-200';
}

function rowKey(s: FillTagSuggestion): string {
  return `${s.filingId}::${s.field}`;
}

interface RecentFillEntry {
  id: string;
  createdAt: string;
  status: string;
  filingTitle: string;
  field: string;
  beforeValue: unknown;
  afterValue: unknown;
  reverted: boolean;
}

/**
 * Parse an ActionLog row's `detail` column. Returns null when the row
 * isn't a well-formed tag-fill entry — caller filters these out.
 */
function parseRecentFill(row: {
  id: string;
  createdAt: string;
  status: string;
  detail: string | null;
  target?: string | null;
}): RecentFillEntry | null {
  if (!row.detail) return null;
  let d: any = null;
  try {
    d = JSON.parse(row.detail);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  if (typeof d.field !== 'string') return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    status: row.status,
    filingTitle: typeof d.filingTitle === 'string' ? d.filingTitle : (row.target ?? ''),
    field: d.field,
    beforeValue: d.beforeValue,
    afterValue: d.afterValue,
    reverted: d.reverted === true || row.status === 'reverted',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export function TagFillReviewPanel({
  caseId,
  suggestions,
  note,
  scanned,
  onClose,
  onApplied,
}: TagFillReviewPanelProps) {
  // accepted: set of rowKey(s) currently checked.
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set());
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [view, setView] = useState<'suggestions' | 'recent'>('suggestions');

  // ── recent fills view state ─────────────────────────────────────────────
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentFillEntry[]>([]);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  // Filing-id-prefixed expand toggles for "Why" excerpts.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Group suggestions by filing for sectioned rendering.
  const grouped = useMemo(() => {
    const groups = new Map<string, { title: string; rows: FillTagSuggestion[] }>();
    for (const s of suggestions) {
      const g = groups.get(s.filingId);
      if (g) {
        g.rows.push(s);
      } else {
        groups.set(s.filingId, { title: s.filingTitle, rows: [s] });
      }
    }
    return Array.from(groups.entries()).map(([filingId, v]) => ({
      filingId,
      title: v.title,
      rows: v.rows,
    }));
  }, [suggestions]);

  const totalRows = suggestions.length;
  const filingCount = grouped.length;

  const toggleRow = useCallback((key: string) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const acceptAll = useCallback(() => {
    setAccepted(new Set(suggestions.map(rowKey)));
  }, [suggestions]);

  const acceptHighConfidence = useCallback(() => {
    setAccepted(
      new Set(suggestions.filter((s) => s.confidence === 'high').map(rowKey)),
    );
  }, [suggestions]);

  const clearAcceptance = useCallback(() => {
    setAccepted(new Set());
  }, []);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Apply selected suggestions ──────────────────────────────────────────
  const handleApply = useCallback(async () => {
    if (accepted.size === 0 || applying) return;
    setApplying(true);
    setApplyError(null);

    const acceptList = suggestions
      .filter((s) => accepted.has(rowKey(s)))
      .map((s) => ({ filingId: s.filingId, field: s.field }));

    try {
      const res = await fetch(`/api/cases/${caseId}/fill-haystack-tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, accept: acceptList }),
      });
      if (!res.ok) {
        let msg = `Apply failed (HTTP ${res.status})`;
        try {
          const d = (await res.json()) as { error?: string };
          if (d?.error) msg = d.error;
        } catch {
          /* keep default */
        }
        setApplyError(msg);
        return;
      }
      // Prefer the server's `applied.length` since Agent E silently skips
      // commits that fail mid-batch. Fall back to acceptList.length when the
      // response shape is older (no applied field).
      let appliedCount = acceptList.length;
      try {
        const d = (await res.json()) as { applied?: unknown[] };
        if (Array.isArray(d.applied)) appliedCount = d.applied.length;
      } catch {
        /* keep default */
      }
      onApplied?.({ accepted: appliedCount });
      onClose();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setApplying(false);
    }
  }, [accepted, applying, suggestions, caseId, onApplied, onClose]);

  // ── Load recent fills when the user switches to that view ──────────────
  const loadRecent = useCallback(async () => {
    setRecentLoading(true);
    setRecentError(null);
    try {
      const res = await fetch(
        `/api/admin/action-logs?caseId=${encodeURIComponent(caseId)}&logType=tag-fill&limit=50`,
      );
      if (!res.ok) {
        setRecentError(`Failed to load (HTTP ${res.status})`);
        setRecent([]);
        return;
      }
      const data = (await res.json()) as {
        logs?: Array<{
          id: string;
          createdAt: string;
          status: string;
          detail: string | null;
          target?: string | null;
        }>;
      };
      const entries = (data.logs ?? [])
        .map(parseRecentFill)
        .filter((x): x is RecentFillEntry => x != null);
      setRecent(entries);
    } catch (e) {
      setRecentError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setRecentLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (view === 'recent') void loadRecent();
  }, [view, loadRecent]);

  // ── Revert a single ActionLog entry ─────────────────────────────────────
  const handleRevert = useCallback(
    async (entry: RecentFillEntry) => {
      if (revertingId) return;
      if (entry.reverted) return;
      setRevertingId(entry.id);
      try {
        const res = await fetch(
          `/api/cases/${caseId}/fill-haystack-tags/revert`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actionLogId: entry.id }),
          },
        );
        if (res.ok) {
          // Mark locally; the server has flipped reverted=true.
          setRecent((prev) =>
            prev.map((r) =>
              r.id === entry.id ? { ...r, reverted: true, status: 'reverted' } : r,
            ),
          );
          return;
        }
        // Treat "already_reverted" as a successful no-op so the UI converges.
        let errCode = '';
        try {
          const d = (await res.json()) as { error?: string };
          errCode = d?.error ?? '';
        } catch {
          /* ignore */
        }
        if (errCode === 'already_reverted') {
          setRecent((prev) =>
            prev.map((r) =>
              r.id === entry.id ? { ...r, reverted: true, status: 'reverted' } : r,
            ),
          );
          return;
        }
        // Other errors surface as inline status text on the row.
        setRecent((prev) =>
          prev.map((r) =>
            r.id === entry.id
              ? { ...r, status: `error: ${errCode || res.status}` }
              : r,
          ),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'network error';
        setRecent((prev) =>
          prev.map((r) =>
            r.id === entry.id ? { ...r, status: `error: ${msg}` } : r,
          ),
        );
      } finally {
        setRevertingId(null);
      }
    },
    [caseId, revertingId],
  );

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-white border-l border-gray-200 shadow-xl flex flex-col"
      role="dialog"
      aria-label="Tag-fill review panel"
    >
      {/* Header */}
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 flex-1 min-w-0 truncate">
            {view === 'suggestions'
              ? `Tag-fill suggestions — ${filingCount} filing${filingCount === 1 ? '' : 's'}, ${totalRows} proposal${totalRows === 1 ? '' : 's'}`
              : 'Recent tag-fill changes'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* View toggle + bulk actions */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setView('suggestions')}
            className={`h-7 px-2 text-xs rounded transition-colors ${
              view === 'suggestions'
                ? 'bg-gray-800 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Suggestions
          </button>
          <button
            type="button"
            onClick={() => setView('recent')}
            className={`h-7 px-2 text-xs rounded transition-colors ${
              view === 'recent'
                ? 'bg-gray-800 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
            title="Open the recent applied tag-fills view to revert changes."
          >
            Recent tag-fill changes
          </button>

          {view === 'suggestions' && totalRows > 0 && (
            <>
              <span className="ml-auto" />
              <button
                type="button"
                onClick={acceptHighConfidence}
                title="Select only high-confidence rows"
                className="h-7 px-2 text-xs text-gray-700 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                Accept high
              </button>
              <button
                type="button"
                onClick={acceptAll}
                title="Select every row"
                className="h-7 px-2 text-xs text-gray-700 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                Accept all
              </button>
              <button
                type="button"
                onClick={clearAcceptance}
                title="Deselect all"
                className="h-7 px-2 text-xs text-gray-700 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                Clear
              </button>
            </>
          )}
        </div>

        {note && view === 'suggestions' && (
          <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            {note}
          </p>
        )}
        {typeof scanned === 'number' && view === 'suggestions' && (
          <p className="mt-1 text-[11px] text-gray-500">
            Scanned {scanned} filing{scanned === 1 ? '' : 's'}.
          </p>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {view === 'suggestions' ? (
          totalRows === 0 ? (
            <div className="p-4 text-sm text-gray-500">
              No suggestions to review.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {grouped.map((g) => (
                <SuggestionGroup
                  key={g.filingId}
                  title={g.title}
                  rows={g.rows}
                  accepted={accepted}
                  expanded={expanded}
                  onToggleRow={toggleRow}
                  onToggleExpanded={toggleExpanded}
                />
              ))}
            </div>
          )
        ) : (
          <RecentView
            entries={recent}
            loading={recentLoading}
            error={recentError}
            revertingId={revertingId}
            onRevert={handleRevert}
          />
        )}
      </div>

      {/* Footer */}
      {view === 'suggestions' && (
        <div className="border-t border-gray-200 px-4 py-3 flex items-center gap-2">
          <span className="text-xs text-gray-600">
            {accepted.size} selected
          </span>
          {applyError && (
            <span
              className="text-[11px] text-red-700 truncate"
              title={applyError}
            >
              {applyError}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-7 px-2.5 text-xs text-gray-700 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={accepted.size === 0 || applying}
              className="h-7 px-2.5 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {applying ? 'Applying…' : `Apply ${accepted.size} accepted`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SuggestionGroup — one filing's worth of rows.
// ────────────────────────────────────────────────────────────────────────────

interface SuggestionGroupProps {
  title: string;
  rows: FillTagSuggestion[];
  accepted: Set<string>;
  expanded: Set<string>;
  onToggleRow(key: string): void;
  onToggleExpanded(key: string): void;
}

function SuggestionGroup({
  title,
  rows,
  accepted,
  expanded,
  onToggleRow,
  onToggleExpanded,
}: SuggestionGroupProps) {
  return (
    <div className="px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5 truncate" title={title}>
        {title}
      </div>
      <div className="space-y-1.5">
        {rows.map((row) => {
          const key = rowKey(row);
          const checked = accepted.has(key);
          const isExpanded = expanded.has(key);
          const excerpt = row.sourceExcerpt ?? '';
          const truncated = excerpt.length > 240 ? excerpt.slice(0, 240) + '…' : excerpt;
          return (
            <div
              key={key}
              className={`border rounded-md px-2 py-1.5 text-xs ${
                checked ? 'border-indigo-200 bg-indigo-50/40' : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleRow(key)}
                  className="h-3.5 w-3.5 rounded text-indigo-600"
                  aria-label={`Accept ${row.field} for ${title}`}
                />
                <span className="font-mono text-[12px] text-gray-800 truncate" title={row.field}>
                  {row.field}
                </span>
                <FieldInfoBubble field={row.field} />
                <span
                  className={`ml-auto px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wider ${confidencePill(row.confidence)}`}
                >
                  {row.confidence}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-[12px]">
                <span className="text-gray-500 line-clamp-1" title={String(formatValue(row.currentValue))}>
                  {formatValue(row.currentValue)}
                </span>
                <svg className="w-3 h-3 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
                <span className="text-gray-900 font-medium truncate" title={String(formatValue(row.proposedValue, row.proposedDisplay))}>
                  {formatValue(row.proposedValue, row.proposedDisplay)}
                </span>
                {isRef(row.proposedValue) && (
                  <span className="font-mono text-[10px] text-gray-400 truncate" title={row.proposedValue.val}>
                    @{shortRefId(row.proposedValue.val ?? '')}
                  </span>
                )}
              </div>
              {excerpt && (
                <div className="mt-1">
                  <button
                    type="button"
                    onClick={() => onToggleExpanded(key)}
                    className="text-[11px] text-gray-500 hover:text-gray-800 underline-offset-2 hover:underline"
                  >
                    {isExpanded ? 'Hide why' : 'Why'}
                  </button>
                  {isExpanded && (
                    <div className="mt-1 text-[11px] text-gray-700 bg-gray-50 border border-gray-200 rounded px-2 py-1 whitespace-pre-wrap">
                      {excerpt}
                    </div>
                  )}
                  {!isExpanded && (
                    <div className="text-[11px] text-gray-500 line-clamp-1" title={excerpt}>
                      {truncated}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Inline info bubble — lightweight fallback since TagInfoPopover binds to
// TagSpec rather than field metadata. Uses the native `title` attribute so
// hover surfaces the description without extra portal/positioning code.
// ────────────────────────────────────────────────────────────────────────────

const FIELD_DESCRIPTIONS: Record<string, string> = {
  filedOn: 'Date the filing was stamped received by the court clerk.',
  receivedOn: 'Date the case-management system ingested or received the filing.',
  judgeRef: 'Reference to the judge associated with this filing.',
  movantRef: 'Reference to the party making the motion or request.',
  respondentRef: 'Reference to the responding party.',
  reporterRef: 'Reference to the court reporter (for hearing transcripts).',
  fileRef: 'Reference to the underlying File/Document row for this filing.',
};

function FieldInfoBubble({ field }: { field: HaystackTagField | string }) {
  const desc = FIELD_DESCRIPTIONS[field] ?? `Field "${field}"`;
  return (
    <span
      role="img"
      aria-label={`Info about ${field}`}
      title={desc}
      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] text-gray-500 hover:text-gray-800 hover:border-gray-500 cursor-help select-none"
    >
      ?
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// RecentView — recent applied tag-fills with revert buttons.
// ────────────────────────────────────────────────────────────────────────────

interface RecentViewProps {
  entries: RecentFillEntry[];
  loading: boolean;
  error: string | null;
  revertingId: string | null;
  onRevert(entry: RecentFillEntry): void;
}

function RecentView({ entries, loading, error, revertingId, onRevert }: RecentViewProps) {
  if (loading) {
    return <div className="p-4 text-sm text-gray-500">Loading recent fills…</div>;
  }
  if (error) {
    return <div className="p-4 text-sm text-red-600">{error}</div>;
  }
  if (entries.length === 0) {
    return (
      <div className="p-4 text-sm text-gray-500">
        No recent tag-fill changes for this case.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-gray-100">
      {entries.map((entry) => {
        const isReverting = revertingId === entry.id;
        return (
          <li key={entry.id} className="px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-400 font-mono">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
              <span
                className={`ml-auto px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${
                  entry.reverted
                    ? 'bg-gray-100 text-gray-500 border-gray-200'
                    : 'bg-green-50 text-green-700 border-green-200'
                }`}
              >
                {entry.reverted ? 'reverted' : 'applied'}
              </span>
            </div>
            <div className="mt-1 text-gray-800 truncate" title={entry.filingTitle}>
              {entry.filingTitle || '(unknown filing)'}
              <span className="ml-1 text-gray-400">·</span>
              <span className="ml-1 font-mono text-[11px] text-gray-700">{entry.field}</span>
            </div>
            <div className="mt-1 flex items-center gap-1 text-[12px]">
              <span className="text-gray-500 truncate" title={String(formatValue(entry.beforeValue))}>
                {formatValue(entry.beforeValue)}
              </span>
              <svg className="w-3 h-3 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
              <span className="text-gray-900 truncate" title={String(formatValue(entry.afterValue))}>
                {formatValue(entry.afterValue)}
              </span>
              <button
                type="button"
                onClick={() => onRevert(entry)}
                disabled={entry.reverted || isReverting}
                className="ml-auto h-6 px-2 text-[11px] text-gray-700 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={entry.reverted ? 'Already reverted' : 'Restore the previous value'}
              >
                {isReverting ? 'Reverting…' : entry.reverted ? 'Reverted' : 'Revert'}
              </button>
            </div>
            {entry.status?.startsWith('error:') && (
              <div className="mt-1 text-[11px] text-red-600">{entry.status}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
