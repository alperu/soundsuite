'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { pickAnchor, type PopupAnchor } from '@/components/case/popup-anchor';
import { linkVerdicts, slotLabel, type LinkPlan, type LinkVerdict } from './link-rules';
import type { EntityKey, ScopeGraph } from './scope-graph';

/**
 * Pick a link target from a list instead of dragging to it.
 *
 * A drag needs both ends on screen at a zoom where you can aim; with seven kind
 * columns and five case bands that is often two pans away. The picker asks the
 * same question the drag asks — it is built on `linkVerdicts`, so a row that
 * offers itself here is a row a drop would have accepted — and hands back the
 * PLAN, never a target id. The caller commits what it was given rather than
 * re-deriving it, which is where an inversion bug (orderRef writes on the
 * ORDER) would otherwise hide.
 *
 * Disabled rows are deliberately rare: incompatible candidates are simply
 * absent until the user's own search matches one, at which point the row
 * appears greyed with the rule's own sentence. Searching for something you
 * cannot link should say WHY; browsing should not wade through refusals.
 */

const POPUP_W = 340;
/** Twelve rows before it scrolls — enough to browse, short enough to place. */
const POPUP_MAX_H = 12 * 34 + 44;

export interface LinkPickerProps {
  graph: ScopeGraph;
  /** The block the link leaves from. */
  sourceKey: EntityKey;
  /** Which slot is being written; omitted for a hub-side pick. */
  slot?: string;
  side: 'input' | 'output';
  /** Where to open — the rect of the circle that was clicked. */
  anchorRect: DOMRect;
  onPick: (plan: LinkPlan) => void;
  onClose: () => void;
}

interface Row {
  verdict: LinkVerdict;
  label: string;
  kind: string;
  caseName: string;
  date: string | null;
  sameCase: boolean;
}

/** ISO → the short form a docket reader scans; null stays visibly absent. */
function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function LinkPicker({
  graph,
  sourceKey,
  slot,
  side,
  anchorRect,
  onPick,
  onClose,
}: LinkPickerProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [anchor] = useState<PopupAnchor>(() => pickAnchor(anchorRect, POPUP_W, POPUP_MAX_H));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sourceCase = graph.caseOfFiling.get(sourceKey) ?? null;

  // Every candidate, once. The verdicts carry the plans, so picking a row is a
  // lookup rather than a second trip through the rules.
  const rows = useMemo<Row[]>(() => {
    const built: Row[] = [];
    for (const verdict of linkVerdicts(graph, sourceKey, { slot, side })) {
      const filing = graph.filingById.get(verdict.key.replace(/^filing:/, ''));
      const kase = graph.caseById.get(verdict.key.replace(/^case:/, ''));
      if (filing) {
        built.push({
          verdict,
          label: filing.label,
          kind: filing.primaryKind,
          caseName: graph.caseById.get(filing.caseId)?.name ?? '',
          date: shortDate(filing.filingDate),
          sameCase: graph.caseOfFiling.get(verdict.key) === sourceCase,
        });
      } else if (kase) {
        built.push({
          verdict,
          label: kase.name,
          kind: 'case',
          caseName: '',
          date: null,
          sameCase: `case:${kase.id}` === sourceCase,
        });
      }
    }
    // Same case first, then docket order. Undated filings sort last rather than
    // first: with `filingDate` null across most of the corpus, treating absence
    // as "earliest" would put the least-known rows at the top.
    built.sort((a, z) => {
      if (a.sameCase !== z.sameCase) return a.sameCase ? -1 : 1;
      if (a.date && z.date && a.date !== z.date) return a.date < z.date ? -1 : 1;
      if (!!a.date !== !!z.date) return a.date ? -1 : 1;
      return a.label.localeCompare(z.label);
    });
    return built;
  }, [graph, sourceKey, slot, side, sourceCase]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter(row => {
      const matches =
        !needle ||
        row.label.toLowerCase().includes(needle) ||
        row.kind.toLowerCase().includes(needle) ||
        row.caseName.toLowerCase().includes(needle);
      if (!matches) return false;
      // Refusals are teaching material for a search that found them, not
      // furniture to scroll past while browsing.
      return row.verdict.ok || needle.length > 0;
    });
  }, [rows, query]);

  // Clamped during render rather than corrected by an effect: a filter that
  // shortens the list must not cost a second render pass to agree with itself.
  const activeIndex = highlight < results.length ? highlight : 0;

  const commit = (row: Row | undefined) => {
    if (!row?.verdict.ok || !row.verdict.plan) return;
    onPick(row.verdict.plan);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight(h => Math.min(h + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit(results[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`);
    // Optional-called: jsdom has no scrollIntoView, and a picker that throws
    // in tests is a picker nobody can test.
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const left = anchor.horizontal === 'left' ? anchorRect.left : anchorRect.right - POPUP_W;
  const top = anchor.vertical === 'below' ? anchorRect.bottom + 4 : anchorRect.top - POPUP_MAX_H - 4;
  const enabledCount = results.filter(r => r.verdict.ok).length;

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl"
      style={{ left, top, width: POPUP_W, maxHeight: POPUP_MAX_H }}
      data-link-picker={slot ?? 'hub'}
      onKeyDown={onKeyDown}
    >
      <div className="border-b border-gray-100 px-2 py-1.5">
        <input
          ref={inputRef}
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          placeholder={`Link ${slot ? slotLabel(slot as never) : 'this block'} to…`}
          className="w-full rounded border border-gray-200 px-2 py-1 text-[12px] outline-none focus:border-blue-400"
        />
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto py-1">
        {results.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-gray-400">
            {rows.some(r => r.verdict.ok)
              ? 'Nothing matches that search.'
              : 'Nothing on this canvas can take that link.'}
          </div>
        )}
        {results.map((row, index) => {
          const active = index === activeIndex;
          const disabled = !row.verdict.ok;
          return (
            <button
              key={row.verdict.key}
              data-row-index={index}
              data-link-row={row.verdict.key}
              data-row-enabled={disabled ? 'no' : 'yes'}
              disabled={disabled}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => commit(row)}
              title={disabled ? row.verdict.reason : undefined}
              className={`block w-full px-3 py-1 text-left ${
                disabled ? 'cursor-not-allowed opacity-45' : active ? 'bg-blue-50' : ''
              }`}
            >
              <div className="truncate text-[12px] text-gray-800">{row.label}</div>
              <div className="truncate text-[10px] text-gray-500">
                {row.kind}
                {row.date ? ` · ${row.date}` : ''}
                {row.caseName && !row.sameCase ? ` · ${row.caseName}` : ''}
                {disabled && row.verdict.reason ? ` — ${row.verdict.reason}` : ''}
              </div>
            </button>
          );
        })}
      </div>
      <div className="border-t border-gray-100 px-2 py-1 text-[10px] text-gray-400">
        {enabledCount} can take this link · ↑↓ to move, Enter to link, Esc to close
      </div>
    </div>
  );
}
