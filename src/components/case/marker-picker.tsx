'use client';

/**
 * MarkerPicker — combo search-with-dropdown for adding marker tags
 * to an entity in the tag panel. Filter by typing; pick with mouse
 * or keyboard (↑/↓ navigate, Enter selects, Esc closes).
 *
 * Mirrors the keyboard/dropdown UX patterns from RefPicker but is
 * fully client-side: the candidate list (`available`) is supplied
 * by the parent from `tag-spec.ts`, so no fetch is needed.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TagSpec } from './tag-spec';

export interface MarkerPickerProps {
  /** Full marker spec list available for this entity kind (from tag-spec.ts). */
  available: TagSpec[];
  /** Currently-set marker names. Picker hides these from results. */
  current: Set<string>;
  /** Called when the user adds a marker. Append to draft state. */
  onAdd(markerName: string): void;
  /** Optional placeholder. Default "Add marker…" */
  placeholder?: string;
}

const MAX_RESULTS = 8;

function rankMatches(available: TagSpec[], current: Set<string>, query: string): TagSpec[] {
  const q = query.trim().toLowerCase();
  // Filter: only markers, not internal, not already set, must include query
  const candidates = available.filter(
    (s) => s.tier === 'marker' && !s.internal && !current.has(s.name),
  );
  if (!q) return candidates.slice(0, MAX_RESULTS);

  const prefix: TagSpec[] = [];
  const substring: TagSpec[] = [];
  for (const s of candidates) {
    const n = s.name.toLowerCase();
    if (n.startsWith(q)) prefix.push(s);
    else if (n.includes(q)) substring.push(s);
  }
  prefix.sort((a, b) => a.name.localeCompare(b.name));
  substring.sort((a, b) => a.name.localeCompare(b.name));
  return [...prefix, ...substring].slice(0, MAX_RESULTS);
}

export function MarkerPicker({
  available,
  current,
  onAdd,
  placeholder = 'Add marker…',
}: MarkerPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo(
    () => rankMatches(available, current, query),
    [available, current, query],
  );

  // Keep highlight within results bounds.
  useEffect(() => {
    if (highlight >= results.length) setHighlight(0);
  }, [results.length, highlight]);

  // Click-outside closes dropdown.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const commit = useCallback(
    (spec: TagSpec | undefined) => {
      if (!spec) return;
      onAdd(spec.name);
      setQuery('');
      setHighlight(0);
      // Keep focus so user can add another.
      inputRef.current?.focus();
    },
    [onAdd],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
        setHighlight((h) => (results.length === 0 ? 0 : (h + 1) % results.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
        setHighlight((h) =>
          results.length === 0 ? 0 : (h - 1 + results.length) % results.length,
        );
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results.length === 0) return;
        const idx = highlight < results.length ? highlight : 0;
        commit(results[idx]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    },
    [results, highlight, commit],
  );

  const showDropdown = open && results.length > 0;

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-center gap-1 px-1.5 py-0.5 border border-gray-300 rounded bg-white focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500">
        <span className="text-gray-400 text-[11px] leading-none select-none" aria-hidden="true">
          +
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="flex-1 min-w-0 text-[11px] bg-transparent outline-none placeholder-gray-400"
        />
      </div>

      {showDropdown && (
        <div
          role="listbox"
          className="absolute left-0 right-0 mt-1 z-20 bg-white border border-gray-200 rounded-lg shadow-md max-h-56 overflow-y-auto"
        >
          {results.map((spec, idx) => {
            const active = idx === highlight;
            return (
              <button
                key={spec.name}
                role="option"
                aria-selected={active}
                type="button"
                onMouseDown={(e) => {
                  // Prevent input blur before click handler runs.
                  e.preventDefault();
                }}
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => commit(spec)}
                className={`w-full text-left px-2 py-1 flex items-center gap-2 transition-colors ${
                  active ? 'bg-emerald-50' : 'hover:bg-gray-50'
                }`}
              >
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-800 border border-emerald-200 flex-shrink-0">
                  {spec.name}
                </span>
                <span className="text-[10px] text-gray-500 truncate">{spec.doc}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
