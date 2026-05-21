'use client';

/**
 * Haystack-style filter input with token autocomplete.
 *
 * Users type `judge:` (or any recognized token from TOKEN_MAP) and an inline
 * picker pops up; selecting a value inserts a structured chip into the input
 * which compiles to a Haystack filter via haystack-query-builder.
 *
 * Modes coexist:
 *   - Plain text (residual freetext that survives along the chips)
 *   - Filter chips (rendered as pills with category-colored borders)
 *
 * Keyboard:
 *   - `<token>:` opens the picker for that token
 *   - Arrow up/down navigates picker options
 *   - Enter selects the focused option (or submits on plain text when picker closed)
 *   - Escape closes the picker
 *   - Backspace at column 0 with empty text removes the last chip
 *
 * The component is intentionally hand-rolled (no cmdk / react-aria dep) since
 * the project's dependency surface (per CLAUDE.md) prefers no new heavy UI
 * libraries here.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FilterChip,
  TOKEN_MAP,
  TOKEN_KEYS,
  ENUM_VALUES,
  personFilterForToken,
} from '@/lib/search/haystack-query-builder';

// ---------------------------------------------------------------------------
// Visual helpers

const categoryClasses: Record<string, string> = {
  ref: 'border-blue-400 bg-blue-50 text-blue-900',
  date: 'border-green-400 bg-green-50 text-green-900',
  enum: 'border-purple-400 bg-purple-50 text-purple-900',
  number: 'border-gray-400 bg-gray-50 text-gray-900',
  text: 'border-gray-300 bg-white text-gray-800',
};

// ---------------------------------------------------------------------------
// Person fetcher — calls the Haystack read endpoint. Returns [] in dev when
// the haystack server isn't live (the route returns a stub).

interface PersonOption {
  id: string;
  label: string;
}

async function fetchPersons(filter: string, query: string): Promise<PersonOption[]> {
  try {
    const url = `/api/haystack/read?filter=${encodeURIComponent(filter)}${
      query ? `&q=${encodeURIComponent(query)}` : ''
    }`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: Array<{ id: string; displayName?: string; name?: string }> };
    const rows = data.results ?? [];
    return rows.map((r) => ({
      id: r.id.startsWith('@') ? r.id : `@${r.id}`,
      label: r.displayName ?? r.name ?? r.id,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Picker mode types

type PickerKind = 'person' | 'date' | 'enum' | 'number' | 'case' | null;

interface PickerState {
  kind: PickerKind;
  /** Surface token key driving the picker (e.g. `judge`, `hearingDate`). */
  token: string;
  /** Current query text typed after the colon. */
  query: string;
  /** Highlighted option index. */
  highlight: number;
  /** Async options for person/case. */
  options: PersonOption[];
}

function pickerKindFor(token: string): PickerKind {
  const def = TOKEN_MAP[token];
  if (!def) return null;
  if (token === 'case') return 'case';
  if (def.category === 'ref') return 'person';
  if (def.category === 'date') return 'date';
  if (def.category === 'enum') return 'enum';
  if (def.category === 'number') return 'number';
  return null;
}

// ---------------------------------------------------------------------------
// Component

export interface HaystackFilterInputProps {
  chips: FilterChip[];
  onChipsChange: (chips: FilterChip[]) => void;
  freetext: string;
  onFreetextChange: (text: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Height of the inner text region. */
  style?: React.CSSProperties;
}

export function HaystackFilterInput({
  chips,
  onChipsChange,
  freetext,
  onFreetextChange,
  onSubmit,
  placeholder = 'Filter or ask… (try judge: hearingDate: motionType:)',
  disabled,
  className,
  style,
}: HaystackFilterInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);

  // Detect a recognized token-prefix in the current freetext (e.g. `judge:roberts`)
  // and open the picker for that token.
  useEffect(() => {
    const m = freetext.match(/(?:^|\s)(\w+):([^\s]*)$/);
    if (!m) {
      if (picker) setPicker(null);
      return;
    }
    const token = m[1];
    const query = m[2];
    if (!TOKEN_MAP[token]) {
      if (picker) setPicker(null);
      return;
    }
    const kind = pickerKindFor(token);
    if (!kind) return;
    // If the picker is already for this token, just update the query
    if (picker && picker.token === token) {
      setPicker({ ...picker, query, highlight: 0 });
    } else {
      setPicker({ kind, token, query, highlight: 0, options: [] });
    }
  }, [freetext]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load async options for person/case pickers.
  useEffect(() => {
    if (!picker) return;
    if (picker.kind !== 'person' && picker.kind !== 'case') return;
    const filter =
      picker.kind === 'case' ? 'case' : (personFilterForToken(picker.token) ?? 'person');
    let cancelled = false;
    fetchPersons(filter, picker.query).then((opts) => {
      if (cancelled) return;
      setPicker((p) =>
        p && p.token === picker.token ? { ...p, options: opts, highlight: 0 } : p,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [picker?.token, picker?.query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Strip the trailing `token:partial` from the freetext when a chip is committed.
  const stripTokenPrefix = useCallback(
    (text: string, token: string): string => {
      const re = new RegExp(`(?:^|\\s)${token}:[^\\s]*$`);
      return text.replace(re, '').trimEnd();
    },
    [],
  );

  const commitChip = useCallback(
    (token: string, value: string, label?: string) => {
      onChipsChange([...chips, { key: token, value, label }]);
      onFreetextChange(stripTokenPrefix(freetext, token));
      setPicker(null);
      // Keep focus
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [chips, freetext, onChipsChange, onFreetextChange, stripTokenPrefix],
  );

  const removeChipAt = useCallback(
    (idx: number) => {
      onChipsChange(chips.filter((_, i) => i !== idx));
    },
    [chips, onChipsChange],
  );

  // ---------------------------------------------------------------------------
  // Picker option list (memoized per kind)

  const pickerOptions: { value: string; label: string }[] = useMemo(() => {
    if (!picker) return [];
    switch (picker.kind) {
      case 'enum': {
        const all = ENUM_VALUES[picker.token] ?? [];
        const q = picker.query.toLowerCase();
        return all
          .filter((v) => v.toLowerCase().includes(q))
          .map((v) => ({ value: v, label: v }));
      }
      case 'person':
      case 'case':
        return picker.options.map((o) => ({ value: o.id, label: o.label }));
      case 'date':
      case 'number':
        // Free-form value; show the typed query as the lone confirmable option.
        return picker.query ? [{ value: picker.query, label: picker.query }] : [];
      default:
        return [];
    }
  }, [picker]);

  // ---------------------------------------------------------------------------
  // Token-prefix suggester: when user types `j` (no colon yet), suggest tokens.

  const tokenSuggestions = useMemo(() => {
    if (picker) return [];
    const m = freetext.match(/(?:^|\s)(\w+)$/);
    if (!m) return [];
    const partial = m[1].toLowerCase();
    if (partial.length < 1) return [];
    const matches = TOKEN_KEYS.filter((k) => k.toLowerCase().startsWith(partial));
    // Only suggest if there's no exact match (otherwise user has finished typing the token).
    if (matches.length === 0 || (matches.length === 1 && matches[0].toLowerCase() === partial)) {
      return [];
    }
    return matches.slice(0, 8);
  }, [freetext, picker]);

  const [tokenHighlight, setTokenHighlight] = useState(0);
  useEffect(() => {
    setTokenHighlight(0);
  }, [tokenSuggestions.length]);

  const completeToken = useCallback(
    (token: string) => {
      // Replace the trailing `\w+` with `token:`.
      const next = freetext.replace(/(?:^|\s)(\w+)$/, (m) => {
        // preserve leading whitespace if any
        const ws = m.match(/^\s/) ? ' ' : '';
        return `${ws}${token}:`;
      });
      onFreetextChange(next);
    },
    [freetext, onFreetextChange],
  );

  // ---------------------------------------------------------------------------
  // Keyboard

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Picker open: arrow / enter / escape
      if (picker && pickerOptions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setPicker((p) =>
            p ? { ...p, highlight: Math.min(p.highlight + 1, pickerOptions.length - 1) } : p,
          );
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setPicker((p) => (p ? { ...p, highlight: Math.max(p.highlight - 1, 0) } : p));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const opt = pickerOptions[picker.highlight];
          if (opt) commitChip(picker.token, opt.value, opt.label);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setPicker(null);
          return;
        }
      }

      // Token suggestions visible: navigate / complete
      if (tokenSuggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setTokenHighlight((h) => Math.min(h + 1, tokenSuggestions.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setTokenHighlight((h) => Math.max(h - 1, 0));
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !picker)) {
          e.preventDefault();
          completeToken(tokenSuggestions[tokenHighlight]);
          return;
        }
      }

      // Backspace at empty input → remove last chip.
      if (e.key === 'Backspace' && freetext === '' && chips.length > 0) {
        e.preventDefault();
        onChipsChange(chips.slice(0, -1));
        return;
      }

      // Plain Enter → submit.
      if (e.key === 'Enter' && !e.shiftKey && !picker) {
        e.preventDefault();
        onSubmit?.();
      }
    },
    [
      picker,
      pickerOptions,
      tokenSuggestions,
      tokenHighlight,
      freetext,
      chips,
      commitChip,
      completeToken,
      onChipsChange,
      onSubmit,
    ],
  );

  // ---------------------------------------------------------------------------
  // Render

  const showPicker = !!picker && pickerOptions.length > 0;
  const showTokens = tokenSuggestions.length > 0 && !showPicker;

  return (
    <div className={`relative ${className ?? ''}`} style={style}>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border border-gray-300 rounded-lg bg-white focus-within:ring-2 focus-within:ring-purple-500 focus-within:border-transparent min-h-[44px]">
        {chips.map((c, i) => {
          const def = TOKEN_MAP[c.key];
          const cat = def?.category ?? 'text';
          return (
            <span
              key={`${c.key}-${i}-${c.value}`}
              className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded-full ${categoryClasses[cat] ?? categoryClasses.text}`}
              title={`${c.key}: ${c.label ?? c.value}`}
            >
              <span className="opacity-70">{c.key}:</span>
              <span>{c.label ?? c.value}</span>
              <button
                type="button"
                onClick={() => removeChipAt(i)}
                className="ml-0.5 text-current opacity-60 hover:opacity-100"
                aria-label={`Remove ${c.key} filter`}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          value={freetext}
          onChange={(e) => onFreetextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={chips.length === 0 ? placeholder : ''}
          disabled={disabled}
          className="flex-1 min-w-[120px] px-1 py-1 text-sm bg-transparent outline-none border-0"
        />
      </div>

      {showPicker && (
        <div className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-100">
            {picker!.kind === 'person'
              ? `Person · ${personFilterForToken(picker!.token) ?? 'person'}`
              : picker!.kind === 'case'
              ? 'Case'
              : picker!.kind === 'date'
              ? 'Date (YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD)'
              : picker!.kind === 'enum'
              ? `${picker!.token} (enum)`
              : 'Value'}
          </div>
          {pickerOptions.map((opt, i) => (
            <button
              key={`${opt.value}-${i}`}
              type="button"
              onMouseDown={(e) => {
                // mousedown (not click) so the input keeps focus
                e.preventDefault();
                commitChip(picker!.token, opt.value, opt.label);
              }}
              className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-purple-50 ${
                i === picker!.highlight ? 'bg-purple-100' : ''
              }`}
            >
              <span className="font-medium">{opt.label}</span>
              {opt.value !== opt.label && (
                <span className="ml-2 text-xs text-gray-500">{opt.value}</span>
              )}
            </button>
          ))}
          {pickerOptions.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-500">No matches</div>
          )}
        </div>
      )}

      {showTokens && (
        <div className="absolute z-30 left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-100">
            Filter tokens
          </div>
          {tokenSuggestions.map((tok, i) => {
            const def = TOKEN_MAP[tok];
            return (
              <button
                key={tok}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  completeToken(tok);
                }}
                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-purple-50 ${
                  i === tokenHighlight ? 'bg-purple-100' : ''
                }`}
              >
                <span className="font-mono">{tok}:</span>
                <span className="ml-2 text-xs text-gray-500">{def.category}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
