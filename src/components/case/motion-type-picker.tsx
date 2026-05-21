'use client';

/**
 * MotionTypePicker — combo search-with-dropdown for editing
 * Motion.motionType. The candidate list comes from
 * src/lib/filings/motion-types.ts (MOTION_TYPES catalogue).
 *
 * UX mirrors MarkerPicker / RefPicker:
 *  - input + chevron → click or type to open the dropdown
 *  - ↑/↓ navigate, Enter selects, Esc closes, Backspace on empty clears
 *  - rows show displayName + shortDoc + category chip
 *  - if `allowFreeText` is true and the typed query does not exactly match
 *    a catalog entry, a sticky bottom row lets the user commit the raw
 *    string (motionType is `Str?` in XETO so any slug is legal).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MOTION_TYPES, type MotionTypeEntry } from '@/lib/filings/motion-types';

const MAX_RESULTS = 20;

const CATEGORY_CHIP: Record<string, string> = {
  procedural: 'bg-blue-50 text-blue-700 border-blue-200',
  disposition: 'bg-red-50 text-red-700 border-red-200',
  discovery: 'bg-amber-50 text-amber-700 border-amber-200',
  evidence: 'bg-purple-50 text-purple-700 border-purple-200',
  'family-law': 'bg-pink-50 text-pink-700 border-pink-200',
  appellate: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  protective: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  scheduling: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  other: 'bg-gray-50 text-gray-700 border-gray-200',
};

function chipClass(category: string): string {
  return CATEGORY_CHIP[category] ?? CATEGORY_CHIP.other;
}

function findEntry(slug: string | null | undefined): MotionTypeEntry | undefined {
  if (!slug) return undefined;
  return MOTION_TYPES.find((e) => e.slug === slug);
}

function rankResults(query: string): MotionTypeEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return MOTION_TYPES.slice(0, MAX_RESULTS);

  const prefix: MotionTypeEntry[] = [];
  const substring: MotionTypeEntry[] = [];
  for (const e of MOTION_TYPES) {
    const hay = [
      e.displayName.toLowerCase(),
      e.slug.toLowerCase(),
      ...(e.aliases ?? []).map((a) => a.toLowerCase()),
    ];
    if (hay.some((h) => h.startsWith(q))) prefix.push(e);
    else if (hay.some((h) => h.includes(q))) substring.push(e);
  }
  prefix.sort((a, b) => a.displayName.localeCompare(b.displayName));
  substring.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return [...prefix, ...substring].slice(0, MAX_RESULTS);
}

export interface MotionTypePickerProps {
  /** Current motionType slug. May be null/empty for "no type set". */
  value: string | null;
  /** Called with new slug, or null to clear. */
  onChange(slug: string | null): void;
  /** Allow committing typed text that is not in the catalogue. Default true. */
  allowFreeText?: boolean;
  /** When false, render the read-only display. */
  editable?: boolean;
}

export function MotionTypePicker({
  value,
  onChange,
  allowFreeText = true,
  editable = true,
}: MotionTypePickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => rankResults(query), [query]);

  const trimmed = query.trim();
  const exactMatch = useMemo(
    () =>
      trimmed.length > 0 &&
      results.some(
        (r) =>
          r.slug.toLowerCase() === trimmed.toLowerCase() ||
          r.displayName.toLowerCase() === trimmed.toLowerCase(),
      ),
    [results, trimmed],
  );
  const showFreeText = allowFreeText && trimmed.length > 0 && !exactMatch;

  // Keep highlight bounded.
  useEffect(() => {
    const total = results.length + (showFreeText ? 1 : 0);
    if (total === 0) {
      if (highlight !== 0) setHighlight(0);
    } else if (highlight >= total) {
      setHighlight(0);
    }
  }, [results.length, showFreeText, highlight]);

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

  // Read mode
  if (!editable) {
    const entry = findEntry(value);
    const display = entry ? entry.displayName : value ? String(value) : '';
    if (!display) return null;
    return <span className="text-[11px] text-gray-800 break-words">{display}</span>;
  }

  const commitEntry = (entry: MotionTypeEntry) => {
    onChange(entry.slug);
    setQuery('');
    setHighlight(0);
    setOpen(false);
    inputRef.current?.blur();
  };
  const commitFreeText = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    onChange(v);
    setQuery('');
    setHighlight(0);
    setOpen(false);
    inputRef.current?.blur();
  };
  const clear = () => {
    onChange(null);
    setQuery('');
    setHighlight(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const total = results.length + (showFreeText ? 1 : 0);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      if (total > 0) setHighlight((h) => (h + 1) % total);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (total > 0) setHighlight((h) => (h - 1 + total) % total);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (total === 0) return;
      if (highlight < results.length) {
        commitEntry(results[highlight]);
      } else if (showFreeText) {
        commitFreeText(trimmed);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Backspace' && query === '' && value) {
      e.preventDefault();
      clear();
    }
  };

  // Render the input. When a value is set but query is empty, show the
  // displayName as the input value so the user can see what's selected.
  const currentEntry = findEntry(value);
  const inputValue = open || query
    ? query
    : currentEntry
      ? currentEntry.displayName
      : value ?? '';

  const showDropdown = open && (results.length > 0 || showFreeText);

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-center gap-1 px-1.5 py-0.5 border border-gray-300 rounded bg-white focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          placeholder="Pick a type or type a new one"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => {
            setOpen(true);
            // Clear stale displayName so typing replaces, not appends.
            if (!query && currentEntry) setQuery('');
          }}
          onKeyDown={onKeyDown}
          className="flex-1 min-w-0 text-[11px] bg-transparent outline-none placeholder-gray-400"
        />
        {value && !open && (
          <button
            type="button"
            onClick={clear}
            title="Clear motion type"
            className="text-gray-400 hover:text-gray-700 text-[10px] leading-none px-1"
          >
            ×
          </button>
        )}
        <button
          type="button"
          aria-label="Open motion type dropdown"
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen((o) => !o);
            inputRef.current?.focus();
          }}
          className="text-gray-400 hover:text-gray-700 text-[10px] leading-none px-1"
        >
          ▾
        </button>
      </div>

      {showDropdown && (
        <div
          role="listbox"
          className="absolute left-0 mt-1 z-20 bg-white border border-gray-200 rounded-lg shadow-lg w-[480px] max-w-[calc(100vw-2rem)] max-h-[480px] overflow-y-auto"
        >
          {results.map((entry, idx) => {
            const active = idx === highlight;
            return (
              <button
                key={entry.slug}
                role="option"
                aria-selected={active}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => commitEntry(entry)}
                className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${
                  active ? 'bg-blue-50' : 'hover:bg-gray-50'
                }`}
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-gray-900 truncate">
                    {entry.displayName}
                  </span>
                  {entry.shortDoc && (
                    <span className="block text-xs text-gray-500 truncate">
                      {entry.shortDoc}
                    </span>
                  )}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] border flex-shrink-0 ${chipClass(entry.category)}`}
                >
                  {entry.category}
                </span>
              </button>
            );
          })}
          {showFreeText && (
            <button
              role="option"
              aria-selected={highlight === results.length}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(results.length)}
              onClick={() => commitFreeText(trimmed)}
              className={`sticky bottom-0 w-full text-left px-3 py-2 border-t border-gray-200 bg-white flex items-center gap-2 transition-colors ${
                highlight === results.length ? 'bg-blue-50' : 'hover:bg-gray-50'
              }`}
            >
              <span className="text-xs text-gray-500">Use as-is:</span>
              <span className="text-sm text-gray-900 truncate flex-1">{trimmed}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
