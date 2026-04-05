'use client';

/**
 * SuggestionRow — a single row in the PR-style suggestion queue.
 *
 * Collapsed by default: shows category chip, 1-line diff preview, and four
 * quick-action icons (Accept, Deny, Ignore, Regenerate).
 *
 * Expanded: reveals a full word-level diff, the AI's rationale, confidence,
 * and full-width action buttons.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CATEGORY_COLORS,
  type DenyReasonTagSlug,
  type DraftSuggestionDTO,
  type SuggestionStatus,
} from '@/lib/draft/suggestion-types';
import { diffWords, diffSummaryLine } from '@/lib/draft/suggestion-diff';
import { DenyReasonPopover } from './deny-reason-popover';

export interface SuggestionRowProps {
  suggestion: DraftSuggestionDTO;
  index: number;
  focused: boolean;
  /** When this flips true, the row auto-expands. Used by the editor-hover integration. */
  forceExpanded?: boolean;
  onFocus: () => void;
  onAccept: () => void;
  onDeny: (tags: DenyReasonTagSlug[], freeText: string) => void;
  onIgnore: () => void;
  onRegenerate: () => void;
  onJump: () => void;
  onReopen: () => void;
  canRegenerate: boolean;
  isRegenerating?: boolean;
}

export function SuggestionRow({
  suggestion,
  index,
  focused,
  forceExpanded,
  onFocus,
  onAccept,
  onDeny,
  onIgnore,
  onRegenerate,
  onJump,
  onReopen,
  canRegenerate,
  isRegenerating,
}: SuggestionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [denyOpen, setDenyOpen] = useState(false);
  const denyButtonRef = useRef<HTMLButtonElement>(null);

  // When the parent asserts forceExpanded (e.g. from editor hover), sync to
  // expanded=true. Never auto-collapse — that's left to explicit user action.
  useEffect(() => {
    if (forceExpanded) setExpanded(true);
  }, [forceExpanded]);

  const colors = CATEGORY_COLORS[suggestion.category] ?? CATEGORY_COLORS.other;
  const isResolved = suggestion.status !== 'pending';
  const isStale = suggestion.status === 'stale';

  const diff = useMemo(
    () => diffWords(suggestion.originalText, suggestion.proposedText),
    [suggestion.originalText, suggestion.proposedText]
  );

  const summaryLine = useMemo(
    () => diffSummaryLine(suggestion.originalText, suggestion.proposedText, 80),
    [suggestion.originalText, suggestion.proposedText]
  );

  const handleRowClick = () => {
    onFocus();
    // Always scroll the editor to the anchor — useful for both pending and
    // resolved rows so the user can review where a past edit landed.
    onJump();
    // Expand/collapse on row click for every status.
    setExpanded((e) => !e);
  };

  return (
    <li
      role="option"
      aria-selected={focused}
      aria-label={`Suggestion ${index + 1}: ${suggestion.category}, ${suggestion.reason}`}
      data-suggestion-id={suggestion.id}
      className={
        'group relative border-b border-l-4 bg-white transition-all ' +
        colors.border +
        (focused ? ' ring-2 ring-purple-400 ring-inset' : '') +
        (isResolved ? ' opacity-60' : '') +
        (isStale ? ' bg-red-50' : '')
      }
    >
      {/* Collapsed header row — always visible */}
      <div
        onClick={handleRowClick}
        className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5"
      >
        <span
          className="text-gray-400 transition-transform"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          aria-hidden
        >
          ▸
        </span>
        <span className="w-6 shrink-0 text-[10px] font-mono text-gray-400">#{index + 1}</span>
        <span className={'h-2 w-2 shrink-0 rounded-full ' + colors.dot} aria-hidden />
        <span className={'shrink-0 text-[10px] font-semibold uppercase tracking-wide ' + colors.label}>
          {suggestion.category}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-600" title={summaryLine}>
          {summaryLine}
        </span>
        {suggestion.conflictsWith && suggestion.conflictsWith.length > 0 && (
          <span
            className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700"
            title={`Conflicts with ${suggestion.conflictsWith.length} other suggestion(s)`}
          >
            ⚠ conflict
          </span>
        )}
        {suggestion.regenerationCount > 0 && (
          <span
            className="shrink-0 rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-semibold text-purple-700"
            title={`Regenerated ${suggestion.regenerationCount} time(s)`}
          >
            ↻{suggestion.regenerationCount}
          </span>
        )}
        {/* Persistent Go-To button — always visible, scrolls the editor to
            this suggestion's anchor without toggling the row expansion. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onFocus();
            onJump();
          }}
          title="Go to location in document"
          aria-label="Go to location in document"
          className="shrink-0 flex items-center gap-0.5 rounded border border-purple-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-purple-700 hover:border-purple-400 hover:bg-purple-50 hover:text-purple-900 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <span>Go to</span>
        </button>
        {!isResolved && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <IconButton title="Accept (a)" onClick={(e) => { e.stopPropagation(); onAccept(); }}>
              ✓
            </IconButton>
            <IconButton
              title="Deny (d)"
              onClick={(e) => {
                e.stopPropagation();
                denyButtonRef.current = e.currentTarget as HTMLButtonElement;
                setDenyOpen(true);
              }}
              buttonRef={denyButtonRef}
            >
              ✗
            </IconButton>
            <IconButton title="Ignore (i)" onClick={(e) => { e.stopPropagation(); onIgnore(); }}>
              ⊘
            </IconButton>
            <IconButton
              title={canRegenerate ? 'Regenerate (r)' : `Limit reached (${suggestion.regenerationCount}/3)`}
              onClick={(e) => { e.stopPropagation(); if (canRegenerate) onRegenerate(); }}
              disabled={!canRegenerate || isRegenerating}
            >
              {isRegenerating ? '…' : '↻'}
            </IconButton>
          </div>
        )}
        {isResolved && suggestion.status !== 'stale' && (
          <span className="shrink-0 text-[10px] font-medium text-gray-500">
            {suggestion.status === 'accepted' && '✓ accepted'}
            {suggestion.status === 'denied' && '✗ denied'}
            {suggestion.status === 'ignored' && '⊘ ignored'}
          </span>
        )}
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50/50 px-3 py-2">
          <div className="mb-2 space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Proposed change</div>
            <div className="rounded border border-gray-200 bg-white p-2 text-[12px] leading-relaxed">
              {diff.map((span, i) => {
                if (span.kind === 'equal') return <span key={i}>{span.text}</span>;
                if (span.kind === 'delete')
                  return (
                    <span key={i} className="bg-red-100 text-red-800 line-through decoration-red-400">
                      {span.text}
                    </span>
                  );
                return (
                  <span key={i} className="bg-green-100 text-green-800">
                    {span.text}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="mb-2 text-[11px] text-gray-600">
            <span className="font-semibold">Reason:</span> {suggestion.reason}
          </div>

          {typeof suggestion.confidence === 'number' && (
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Confidence</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full bg-purple-500"
                  style={{ width: `${Math.round(suggestion.confidence * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-gray-500">{Math.round(suggestion.confidence * 100)}%</span>
            </div>
          )}

          {isStale && (
            <div className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
              Document changed — the original text can no longer be located. Accept / Deny /
              Ignore are disabled. Re-run Auto-Suggest to produce fresh proposals.
            </div>
          )}

          {!isResolved && !isStale && (
            <div className="flex flex-wrap gap-1.5">
              <ActionButton variant="primary" onClick={onAccept}>
                Accept
              </ActionButton>
              <ActionButton
                variant="danger"
                onClick={(e) => {
                  denyButtonRef.current = e.currentTarget as HTMLButtonElement;
                  setDenyOpen(true);
                }}
                buttonRef={denyButtonRef}
              >
                Deny
              </ActionButton>
              <ActionButton variant="ghost" onClick={onIgnore}>
                Ignore
              </ActionButton>
              <ActionButton
                variant="secondary"
                onClick={onRegenerate}
                disabled={!canRegenerate || isRegenerating}
                title={
                  !canRegenerate
                    ? `Regeneration limit reached (${suggestion.regenerationCount}/3)`
                    : 'Ask AI for a different phrasing'
                }
              >
                {isRegenerating ? 'Regenerating…' : `Regenerate (${suggestion.regenerationCount}/3)`}
              </ActionButton>
            </div>
          )}

          {isResolved && (
            <button
              type="button"
              onClick={onReopen}
              className="text-[11px] font-medium text-purple-600 hover:text-purple-800 hover:underline"
            >
              ↩ Reopen
            </button>
          )}
        </div>
      )}

      <DenyReasonPopover
        open={denyOpen}
        anchorEl={denyButtonRef.current}
        onCancel={() => setDenyOpen(false)}
        onSubmit={(tags, freeText) => {
          setDenyOpen(false);
          onDeny(tags, freeText);
        }}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Small button components
// ---------------------------------------------------------------------------

function IconButton({
  children,
  title,
  onClick,
  disabled,
  buttonRef,
}: {
  children: React.ReactNode;
  title: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded text-[12px] text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ActionButton({
  children,
  variant,
  onClick,
  disabled,
  title,
  buttonRef,
}: {
  children: React.ReactNode;
  variant: 'primary' | 'danger' | 'ghost' | 'secondary';
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const base = 'rounded px-3 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const variants = {
    primary: 'bg-emerald-600 text-white hover:bg-emerald-700',
    danger: 'bg-white text-red-700 border border-red-300 hover:bg-red-50',
    ghost: 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50',
    secondary: 'bg-purple-600 text-white hover:bg-purple-700',
  } as const;
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${variants[variant]}`}
    >
      {children}
    </button>
  );
}

// Helper type import satisfies TypeScript when `SuggestionStatus` is referenced indirectly.
export type { SuggestionStatus };
