'use client';

import { useMemo, useState } from 'react';
import { primarySlotFor, slotLabel, type LinkPlan } from './link-rules';
import { suggestForSlot, type LinkSuggestion } from './suggest-links';
import { filingKey, type ScopeGraph } from './scope-graph';

/**
 * The pairing workbench: every filing missing its defining link, in one list,
 * with the answer already filled in where the evidence is clear.
 *
 * Linking one filing at a time through the canvas is right when you know what
 * you are looking for. It is the wrong shape for the other job — a case that
 * has just been ingested and needs forty responses attached to their motions.
 * That job is a list with a checkbox, and the gesture is Apply.
 *
 * Suggestions are pre-fill, never decision: a row with no confident answer says
 * so and stays unchecked, and every suggested row wears the reasons it was
 * chosen so disagreeing is one glance rather than an investigation.
 */

export interface WorkbenchRow {
  key: string;
  label: string;
  kind: string;
  slot: string;
  suggestion: LinkSuggestion | null;
  targetLabel: string | null;
}

interface Props {
  graph: ScopeGraph;
  /** Opens the picker for one row so the user can choose a different target. */
  onChoose: (row: WorkbenchRow) => void;
  /** Commit every checked row as one batch. */
  onApply: (plans: LinkPlan[]) => void;
  busy?: boolean;
}

/** The rows worth showing: a filing whose defining slot is still empty. */
export function buildWorkbenchRows(graph: ScopeGraph): WorkbenchRow[] {
  const rows: WorkbenchRow[] = [];
  for (const filing of graph.filings) {
    const slot = primarySlotFor(filing.primaryKind);
    if (!slot) continue;
    if (typeof filing.refs?.[slot] === 'string' && filing.refs[slot]) continue;
    const suggestion = suggestForSlot(graph, filingKey(filing.id), slot);
    rows.push({
      key: filingKey(filing.id),
      label: filing.label,
      kind: filing.primaryKind,
      slot,
      suggestion,
      targetLabel: suggestion
        ? graph.filingById.get(suggestion.targetKey.replace(/^filing:/, ''))?.label ?? null
        : null,
    });
  }
  return rows;
}

export function PairingWorkbench({ graph, onChoose, onApply, busy }: Props) {
  const rows = useMemo(() => buildWorkbenchRows(graph), [graph]);
  // Only suggested rows start checked. A blank row is a question, and checking
  // it by default would turn "I don't know" into a write.
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());

  const checked = rows.filter(row => row.suggestion && !excluded.has(row.key));

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-gray-400">
        Every filing already has its defining link.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-gray-200 px-3 py-2 text-[11px] text-gray-600">
        {rows.length} filings missing a link · {rows.filter(r => r.suggestion).length} suggested
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(row => {
          const isChecked = !!row.suggestion && !excluded.has(row.key);
          return (
            <div
              key={row.key}
              data-workbench-row={row.key}
              data-row-suggested={row.suggestion ? 'yes' : 'no'}
              className="border-b border-gray-100 px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={!row.suggestion}
                  onChange={() =>
                    setExcluded(prev => {
                      const next = new Set(prev);
                      if (next.has(row.key)) next.delete(row.key);
                      else next.add(row.key);
                      return next;
                    })
                  }
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-gray-800">{row.label}</div>
                  <div className="text-[10px] text-gray-500">
                    {row.kind} · needs {slotLabel(row.slot as never)}
                  </div>
                  {row.suggestion ? (
                    <div className="mt-1">
                      <div className="truncate text-[11px] text-gray-700">→ {row.targetLabel}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {row.suggestion.reasons.map(reason => (
                          <span
                            key={reason}
                            className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] text-gray-600"
                          >
                            {reason}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 text-[10px] text-gray-400">
                      No clear candidate — choose one
                    </div>
                  )}
                </div>
                <button
                  onClick={() => onChoose(row)}
                  className="shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-100"
                >
                  {row.suggestion ? 'Change…' : 'Choose…'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 border-t border-gray-200 px-3 py-2">
        <button
          onClick={() => onApply(checked.map(row => row.suggestion!.plan))}
          disabled={busy || checked.length === 0}
          className="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? 'Linking…' : `Link ${checked.length} filings`}
        </button>
        <span className="text-[10px] text-gray-400">one undo for the whole batch</span>
      </div>
    </div>
  );
}
