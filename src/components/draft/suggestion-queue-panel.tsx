'use client';

/**
 * SuggestionQueuePanel — the PR-style review queue that lives in the
 * "Suggestions" tab of the draft chat panel. Shows pending suggestions with
 * filter bar + bulk actions + keyboard navigation, and delegates accept/deny/
 * ignore/regenerate to the parent via callbacks (which in turn call the hook
 * and the editor imperative handle).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DenyReasonTagSlug,
  DraftSuggestionDTO,
  SuggestionStatus,
} from '@/lib/draft/suggestion-types';
import { AIThinkingLog, type AIProgressEntry } from '@/components/search/ai-thinking-log';
import { SuggestionRow } from './suggestion-row';

export interface SuggestionQueuePanelProps {
  suggestions: DraftSuggestionDTO[];
  isStreaming: boolean;
  lastError: string | null;
  /** Thinking-log entries from the most recent Auto-Suggest run. */
  progressLog?: AIProgressEntry[];
  /** Unix ms when the current run started; 0 when idle. */
  runStartTime?: number;
  /**
   * Drives the editor-hover → open-card integration. When this changes to a
   * non-null id, the matching row is focused, expanded, and scrolled into
   * view in the queue list.
   */
  externalHighlightId?: string | null;
  onAccept: (suggestion: DraftSuggestionDTO) => void;
  onDeny: (suggestion: DraftSuggestionDTO, tags: DenyReasonTagSlug[], freeText: string) => void;
  onIgnore: (suggestion: DraftSuggestionDTO) => void;
  onRegenerate: (suggestion: DraftSuggestionDTO) => void;
  onReopen: (suggestion: DraftSuggestionDTO) => void;
  onJump: (suggestion: DraftSuggestionDTO) => void;
  onBulkAction?: (action: 'accept-safe' | 'deny-all' | 'ignore-all', ids: string[]) => void;
  /** Called when the user clicks "Clear learned preferences" in the footer. */
  onClearPreferences?: () => void;
  /** If currently regenerating a specific suggestion, show its id as spinner. */
  regeneratingId?: string | null;
}

type FilterKey = 'pending' | 'accepted' | 'denied' | 'ignored' | 'stale';

export function SuggestionQueuePanel({
  suggestions,
  isStreaming,
  lastError,
  onAccept,
  onDeny,
  onIgnore,
  onRegenerate,
  onReopen,
  onJump,
  onBulkAction,
  onClearPreferences,
  regeneratingId,
  progressLog,
  runStartTime,
  externalHighlightId,
}: SuggestionQueuePanelProps) {
  const [filter, setFilter] = useState<FilterKey>('pending');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);

  // When the editor hover highlights a suggestion, focus + scroll the row
  // into view. The row's own `forceExpanded` prop drives expansion.
  useEffect(() => {
    if (!externalHighlightId) return;
    const highlighted = suggestions.find((s) => s.id === externalHighlightId);
    if (!highlighted) return;
    // Switch to the filter tab that contains the highlighted row so it's
    // actually visible in the list.
    const targetFilter = highlighted.status as FilterKey;
    if (targetFilter !== filter && (['pending', 'accepted', 'denied', 'ignored', 'stale'] as FilterKey[]).includes(targetFilter)) {
      setFilter(targetFilter);
    }
    setFocusedId(externalHighlightId);
    // Wait a tick for any filter change to render, then scroll.
    const raf = requestAnimationFrame(() => {
      const rowEl = listRef.current?.querySelector(
        `li[data-suggestion-id="${CSS.escape(externalHighlightId)}"]`
      ) as HTMLElement | null;
      rowEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [externalHighlightId, suggestions, filter]);

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { pending: 0, accepted: 0, denied: 0, ignored: 0, stale: 0 };
    for (const s of suggestions) {
      const key = s.status as FilterKey;
      if (key in c) c[key]++;
    }
    return c;
  }, [suggestions]);

  const filtered = useMemo(() => {
    const filtered = suggestions.filter((s) => s.status === filter);
    if (filter === 'pending') {
      return [...filtered].sort((a, b) => a.anchorFrom - b.anchorFrom);
    }
    return [...filtered].sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  }, [suggestions, filter]);

  // Keep focused id in range.
  useEffect(() => {
    if (focusedId && !filtered.find((s) => s.id === focusedId)) {
      setFocusedId(filtered[0]?.id ?? null);
    }
  }, [filtered, focusedId]);

  // Keyboard nav when the list has focus.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      if (filtered.length === 0) return;
      const currentIdx = focusedId ? filtered.findIndex((s) => s.id === focusedId) : -1;
      const focused = currentIdx >= 0 ? filtered[currentIdx] : filtered[0];

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = Math.min(filtered.length - 1, currentIdx + 1);
        setFocusedId(filtered[nextIdx].id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const nextIdx = Math.max(0, currentIdx - 1);
        setFocusedId(filtered[nextIdx].id);
      } else if (e.key === 'G') {
        e.preventDefault();
        setFocusedId(filtered[filtered.length - 1].id);
      } else if (e.key === 'g') {
        e.preventDefault();
        setFocusedId(filtered[0].id);
      } else if (!focused || focused.status !== 'pending') {
        return;
      } else if (e.key === 'a') {
        e.preventDefault();
        onAccept(focused);
      } else if (e.key === 'i') {
        e.preventDefault();
        onIgnore(focused);
      } else if (e.key === 'r') {
        e.preventDefault();
        if (focused.regenerationCount < 3) onRegenerate(focused);
      }
      // 'd' for deny is handled by the row (opens popover) — we don't intercept.
    },
    [filtered, focusedId, onAccept, onIgnore, onRegenerate]
  );

  const pendingIds = useMemo(() => suggestions.filter((s) => s.status === 'pending').map((s) => s.id), [suggestions]);
  const safeIds = useMemo(
    () =>
      suggestions
        .filter((s) => s.status === 'pending' && (s.category === 'grammar' || s.category === 'clarity') && (s.confidence ?? 0) >= 0.8)
        .map((s) => s.id),
    [suggestions]
  );

  const hasLog = !!progressLog && progressLog.length > 0;
  const logStart = runStartTime ?? 0;

  // ---- Empty state (only when nothing is happening AND no history to show) ----
  if (suggestions.length === 0 && !isStreaming && !hasLog) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <div className="mb-3 text-4xl">💡</div>
        <div className="mb-2 text-sm font-semibold text-gray-700">No suggestions yet</div>
        <div className="max-w-xs text-[12px] leading-relaxed text-gray-500">
          Toggle <span className="font-semibold text-purple-700">Auto-Suggest</span> ON in the Chat tab, then ask for a pass
          (e.g. <em>&ldquo;tighten the tone&rdquo;</em>). Proposals will stream in here for you to review.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Thinking log — shows live progress (embedding search, deep research
          sub-queries, model generation, per-suggestion creation, warnings). */}
      {hasLog && (
        <div className="shrink-0 border-b border-gray-200 bg-white p-2">
          <AIThinkingLog
            entries={progressLog!}
            expanded={thinkingExpanded}
            onToggle={() => setThinkingExpanded((v) => !v)}
            startTime={logStart || Date.now()}
            loading={isStreaming}
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-gray-200 bg-gray-50 px-2 py-1.5">
        {(['pending', 'accepted', 'denied', 'ignored', 'stale'] as FilterKey[]).map((key) => {
          const active = filter === key;
          const count = counts[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={
                'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ' +
                (active ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200')
              }
            >
              {key.charAt(0).toUpperCase() + key.slice(1)}
              {count > 0 && (
                <span className={'ml-1 text-[10px] ' + (active ? 'opacity-80' : 'text-gray-400')}>({count})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Bulk action bar — only for pending view with ≥3 items */}
      {filter === 'pending' && pendingIds.length >= 3 && onBulkAction && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-gray-200 bg-purple-50 px-2 py-1.5 text-[11px]">
          <span className="text-gray-600">Bulk:</span>
          {safeIds.length > 0 && (
            <button
              type="button"
              onClick={() => onBulkAction('accept-safe', safeIds)}
              className="rounded border border-emerald-300 bg-white px-2 py-0.5 font-medium text-emerald-700 hover:bg-emerald-50"
              title="Accept grammar & clarity suggestions with confidence ≥ 0.8"
            >
              Accept all safe ({safeIds.length})
            </button>
          )}
          <button
            type="button"
            onClick={() => onBulkAction('deny-all', pendingIds)}
            className="rounded border border-red-300 bg-white px-2 py-0.5 font-medium text-red-700 hover:bg-red-50"
          >
            Deny all
          </button>
          <button
            type="button"
            onClick={() => onBulkAction('ignore-all', pendingIds)}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 font-medium text-gray-700 hover:bg-gray-50"
          >
            Ignore all
          </button>
        </div>
      )}

      {/* Error banner */}
      {lastError && (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">{lastError}</div>
      )}

      {/* Streaming indicator (hidden when the thinking log is already showing live state) */}
      {isStreaming && !hasLog && (
        <div className="flex shrink-0 items-center gap-2 border-b border-purple-200 bg-purple-50 px-2 py-1.5 text-[11px] text-purple-700">
          <div className="h-2 w-2 animate-pulse rounded-full bg-purple-500" />
          Generating suggestions…
        </div>
      )}

      {/* List */}
      <ul
        ref={listRef}
        role="listbox"
        aria-multiselectable="false"
        aria-label="Draft suggestions"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
      >
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-[11px] text-gray-400">No {filter} suggestions.</div>
        ) : (
          filtered.map((suggestion, i) => (
            <SuggestionRow
              key={suggestion.id}
              suggestion={suggestion}
              index={i}
              focused={focusedId === suggestion.id}
              forceExpanded={externalHighlightId === suggestion.id}
              onFocus={() => setFocusedId(suggestion.id)}
              onAccept={() => onAccept(suggestion)}
              onDeny={(tags, freeText) => onDeny(suggestion, tags, freeText)}
              onIgnore={() => onIgnore(suggestion)}
              onRegenerate={() => onRegenerate(suggestion)}
              onReopen={() => onReopen(suggestion)}
              onJump={() => onJump(suggestion)}
              canRegenerate={suggestion.regenerationCount < 3}
              isRegenerating={regeneratingId === suggestion.id}
            />
          ))
        )}
      </ul>

      {/* Footer — keyboard hints + privacy controls */}
      <div className="shrink-0 border-t border-gray-200 bg-gray-50 px-2 py-1 flex items-center justify-between gap-2 text-[10px] text-gray-500">
        <div>
          <kbd className="rounded border border-gray-300 bg-white px-1">j</kbd>/<kbd className="rounded border border-gray-300 bg-white px-1">k</kbd> nav ·
          <kbd className="ml-1 rounded border border-gray-300 bg-white px-1">a</kbd> accept ·
          <kbd className="ml-1 rounded border border-gray-300 bg-white px-1">d</kbd> deny ·
          <kbd className="ml-1 rounded border border-gray-300 bg-white px-1">i</kbd> ignore ·
          <kbd className="ml-1 rounded border border-gray-300 bg-white px-1">r</kbd> regen
        </div>
        {onClearPreferences && (
          <button
            type="button"
            onClick={onClearPreferences}
            className="text-[10px] text-gray-500 hover:text-red-600 hover:underline"
            title="Delete all learned preferences from denied/accepted suggestions on this draft"
          >
            Clear learned prefs
          </button>
        )}
      </div>
    </div>
  );
}

export type { SuggestionStatus };
