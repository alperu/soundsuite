'use client';

/**
 * MustachePicker — floating field-name + value suggester for the `{{ }}`
 * mustache composer on /search.
 *
 * The composer is a plain <textarea>; when the user opens a `{{` block and
 * starts typing, this popover surfaces:
 *
 *   Phase A — field name suggestions (motionType, judge, hearingDate, …)
 *             sourced from TOKEN_MAP. Selecting one inserts `<field>==` at
 *             the cursor.
 *   Phase B — value suggestions for the chosen field. Static for `enum`
 *             tokens (ENUM_VALUES), DB-backed for `ref` tokens via
 *             /api/search/path-values. Selecting one inserts the value
 *             (auto-quoted if it contains spaces) at the cursor.
 *
 * Keyboard: ↑/↓ navigate, Enter / Tab inserts, Esc closes.
 * Mouse: click row to insert.
 *
 * Closes automatically when the cursor leaves the unclosed `{{ ... ` block
 * (handled by the parent — we just hide when active==null).
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { TOKEN_MAP, ENUM_VALUES, TOKEN_KEYS } from '@/lib/search/haystack-query-builder';

// ---------------------------------------------------------------------------
// Active-block detection

export type MustacheOp = '==' | '!=' | '>=' | '<=' | '>' | '<';

export interface MustacheActive {
  /** Char index in the textarea where the `{{` opens. */
  openIndex: number;
  /** Raw content between `{{` and the cursor (no operator splitting). */
  raw: string;
  /** Token-name partial (text before any operator). */
  fieldPartial: string;
  /** If user has typed an operator, value-mode is on. */
  op: MustacheOp | null;
  /** Token-name typed before the op (or partial if no op yet). */
  fieldKey: string;
  /** Value text typed after the op (empty if op just typed). */
  valuePartial: string;
}

const OP_REGEX = /(==|!=|>=|<=|>|<)/;

/**
 * Inspect the textarea value + cursor position. If the cursor sits inside an
 * unclosed `{{ ... ` block, returns the active state; otherwise null.
 */
export function detectMustacheActive(
  text: string,
  cursor: number,
): MustacheActive | null {
  if (cursor < 2) return null;
  const upToCursor = text.slice(0, cursor);
  const lastOpen = upToCursor.lastIndexOf('{{');
  if (lastOpen === -1) return null;
  // If a `}}` lives between the open and the cursor, the block is already
  // closed — picker should be off.
  const between = upToCursor.slice(lastOpen + 2);
  if (between.includes('}}')) return null;
  // Also bail if a NEWLINE crashes the block — mustache is line-scoped here.
  if (between.includes('\n')) return null;

  const raw = between;
  const trimmed = raw.replace(/^\s+/, '');
  const m = OP_REGEX.exec(trimmed);
  if (!m) {
    return {
      openIndex: lastOpen,
      raw,
      fieldPartial: trimmed,
      op: null,
      fieldKey: trimmed,
      valuePartial: '',
    };
  }
  const opIdx = m.index;
  const fieldKey = trimmed.slice(0, opIdx).trim();
  const valuePart = trimmed.slice(opIdx + m[1].length).replace(/^\s+/, '');
  return {
    openIndex: lastOpen,
    raw,
    fieldPartial: trimmed.slice(0, opIdx),
    op: m[1] as MustacheOp,
    fieldKey,
    valuePartial: valuePart,
  };
}

// ---------------------------------------------------------------------------
// Value suggestions — path-values endpoint mapping

interface ValueOption {
  value: string;
  label: string;
  secondary?: string;
}

/**
 * Map a TOKEN_MAP key to the `path` parameter the /api/search/path-values
 * endpoint understands. Returns null when no DB lookup is available; the
 * caller falls back to ENUM_VALUES or empty.
 */
function pathForField(field: string): string | null {
  const def = TOKEN_MAP[field];
  if (!def) return null;
  if (def.category !== 'ref') return null;
  if (field === 'case') return 'case->name';
  // judge, lawyer, movant, respondent, clerk, reporter all resolve via
  // the Person table on `displayName`.
  return `${field}->displayName`;
}

function useValueSuggestions(
  field: string,
  partial: string,
  enabled: boolean,
): { options: ValueOption[]; loading: boolean } {
  const [state, setState] = useState<{ options: ValueOption[]; loading: boolean }>({
    options: [],
    loading: false,
  });
  const lastKeyRef = useRef('');

  useEffect(() => {
    if (!enabled) {
      setState({ options: [], loading: false });
      return;
    }

    // Static enum first.
    const enumVals = ENUM_VALUES[field];
    if (enumVals) {
      const lower = partial.toLowerCase();
      const filtered = enumVals
        .filter((v) => !lower || v.toLowerCase().includes(lower))
        .map((v) => ({ value: v, label: v }));
      setState({ options: filtered, loading: false });
      return;
    }

    const path = pathForField(field);
    if (!path) {
      setState({ options: [], loading: false });
      return;
    }

    const key = `${path}|${partial}`;
    lastKeyRef.current = key;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));

    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          path,
          prefix: partial,
          limit: '20',
        });
        const res = await fetch(`/api/search/path-values?${params.toString()}`);
        if (cancelled || lastKeyRef.current !== key) return;
        if (!res.ok) {
          setState({ options: [], loading: false });
          return;
        }
        const json = (await res.json()) as {
          options?: Array<{ value: string; label: string; secondary?: string }>;
        };
        const mapped = (json.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
          secondary: o.secondary,
        }));
        setState({ options: mapped, loading: false });
      } catch {
        if (!cancelled) setState({ options: [], loading: false });
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [field, partial, enabled]);

  return state;
}

// ---------------------------------------------------------------------------
// Component

export interface MustachePickerProps {
  /** Textarea value. */
  value: string;
  /** Caret position inside the textarea. */
  cursorPos: number;
  /** Bounding rect of the textarea (popover anchors to its bottom-left). */
  anchorRect: DOMRect | null;
  /** Called when the user picks a suggestion. Receives the next textarea
   *  value and the new caret position. */
  onInsert: (nextValue: string, nextCursor: number) => void;
  /** Called when the user presses Esc. */
  onClose: () => void;
}

export function MustachePicker({
  value,
  cursorPos,
  anchorRect,
  onInsert,
  onClose,
}: MustachePickerProps) {
  const active = useMemo(
    () => detectMustacheActive(value, cursorPos),
    [value, cursorPos],
  );

  // Phase A — field-name list (static, from TOKEN_MAP)
  const fieldOptions = useMemo(() => {
    if (!active || active.op !== null) return [];
    const q = active.fieldPartial.toLowerCase();
    return TOKEN_KEYS
      .filter((k) => !q || k.toLowerCase().includes(q))
      .slice(0, 20)
      .map((k) => {
        const def = TOKEN_MAP[k];
        return {
          key: k,
          op: def?.op ?? '==',
          category: def?.category ?? 'text',
        };
      });
  }, [active]);

  // Phase B — value list (enum or DB)
  const inValueMode = !!active && active.op !== null && active.fieldKey.length > 0;
  const { options: valueOptions, loading: valuesLoading } = useValueSuggestions(
    active?.fieldKey ?? '',
    active?.valuePartial ?? '',
    inValueMode,
  );

  // Highlight tracking — reset whenever the active mode/key changes.
  const [highlight, setHighlight] = useState(0);
  const modeKey = active
    ? `${active.op ?? 'name'}|${active.fieldKey}|${active.fieldPartial}|${active.valuePartial}`
    : '';
  useEffect(() => {
    setHighlight(0);
  }, [modeKey]);

  const rows: Array<{ primary: string; secondary?: string; insert: string }> =
    inValueMode
      ? valueOptions.map((o) => ({
          primary: o.label,
          secondary: o.secondary,
          // Auto-quote values with spaces or non-word chars
          insert: /[\s"]/.test(o.value) ? `"${o.value.replace(/"/g, '\\"')}"` : o.value,
        }))
      : fieldOptions.map((o) => ({
          primary: `${o.key}${o.op}`,
          secondary: o.category,
          insert: `${o.key}${o.op}`,
        }));

  const insertAtCursor = useCallback(
    (replacement: string, replaceFrom: number, replaceTo: number) => {
      const next = value.slice(0, replaceFrom) + replacement + value.slice(replaceTo);
      const nextCursor = replaceFrom + replacement.length;
      onInsert(next, nextCursor);
    },
    [value, onInsert],
  );

  const commit = useCallback(
    (idx: number) => {
      if (!active) return;
      const row = rows[idx];
      if (!row) return;

      // Locate the slice to replace inside the textarea.
      // The active block runs from `active.openIndex + 2` up to `cursorPos`.
      // For Phase A: replace `fieldPartial` (which is the trimmed text after `{{ `).
      // For Phase B: replace `valuePartial` (text after the operator).
      const blockStart = active.openIndex + 2;
      // Re-derive the exact slice — `raw` is everything between `{{` and cursor.
      // Strip leading whitespace to honor the same `replace(/^\s+/, '')` we did
      // in detectMustacheActive.
      const leadingWs = active.raw.length - active.raw.replace(/^\s+/, '').length;
      const trimmedStart = blockStart + leadingWs;

      if (!inValueMode) {
        // Replace fieldPartial chunk and add a trailing space-free insertion.
        const replaceFrom = trimmedStart;
        const replaceTo = trimmedStart + active.fieldPartial.length;
        insertAtCursor(row.insert, replaceFrom, replaceTo);
      } else {
        // Replace valuePartial chunk.
        const opPos = trimmedStart + active.fieldPartial.length;
        // Account for the operator length plus its leading-after-op whitespace.
        const afterOpStart = opPos + (active.op?.length ?? 0);
        const trimmedRawAfterOp = value.slice(afterOpStart, cursorPos);
        const valueLeadingWs =
          trimmedRawAfterOp.length - trimmedRawAfterOp.replace(/^\s+/, '').length;
        const replaceFrom = afterOpStart + valueLeadingWs;
        const replaceTo = cursorPos;
        insertAtCursor(row.insert, replaceFrom, replaceTo);
      }
    },
    [active, rows, inValueMode, value, cursorPos, insertAtCursor],
  );

  // Keyboard nav — attach to window so it works while the textarea has focus.
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (rows.length === 0 && e.key !== 'Escape') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, rows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (rows.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          commit(highlight);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [active, rows.length, highlight, commit, onClose]);

  if (!active) return null;
  if (rows.length === 0 && !valuesLoading) {
    // Nothing to show — render a small hint so the user knows the picker is alive
    // but empty (e.g. unknown field after operator).
    if (!inValueMode) return null;
  }

  // Positioning — anchor below the textarea bottom-left. Coarse approximation,
  // per spec.
  const style: React.CSSProperties = anchorRect
    ? {
        position: 'fixed',
        top: Math.min(anchorRect.bottom + 4, window.innerHeight - 240),
        left: anchorRect.left + 12,
        width: Math.min(360, anchorRect.width - 24),
        zIndex: 60,
      }
    : { display: 'none' };

  return (
    <div
      style={style}
      className="rounded-lg border border-gray-300 bg-white shadow-lg overflow-hidden"
      role="listbox"
      aria-label={inValueMode ? 'Value suggestions' : 'Field suggestions'}
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <span>
          {inValueMode ? `${active.fieldKey} value` : 'Field'}
        </span>
        {valuesLoading && <span className="text-purple-500">loading…</span>}
      </div>
      <ul className="max-h-56 overflow-y-auto py-1">
        {rows.length === 0 && !valuesLoading && (
          <li className="px-3 py-2 text-xs text-gray-400">No matches</li>
        )}
        {rows.map((row, i) => (
          <li key={`${row.primary}-${i}`}>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commit(i);
              }}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between gap-2 ${
                i === highlight ? 'bg-purple-100' : 'hover:bg-purple-50'
              }`}
            >
              <span className="font-mono text-gray-800 truncate">{row.primary}</span>
              {row.secondary && (
                <span className="text-[10px] text-gray-500 truncate">{row.secondary}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
