'use client';

/**
 * ActiveTokenSuggestions — in-place combo-box for filter-token values.
 *
 * Lives in the left rail of the /search page. When the user types a recognized
 * token prefix into the HaystackFilterInput (e.g. `motionType:`, `judge:`,
 * `case:`), the parent's `activeToken` state turns non-null and this panel
 * renders filtered suggestions. Clicking a row commits a chip via `onPick`.
 *
 * The picker logic that used to live in HaystackFilterInput as a floating
 * dropdown has been hoisted here so suggestions occupy the empty left panel
 * instead of overlaying the input. The arrow-key + Enter handlers still live
 * in HaystackFilterInput; this component just exposes a clickable list and
 * mirrors the `highlight` index passed by the parent.
 *
 * Token-type sourcing:
 *   - `motionType`           → @/lib/filings/motion-types (107 entries)
 *   - `kind` / `attachmentKind` → ENUM_VALUES from haystack-query-builder
 *   - `judge` / `lawyer` / `movant` / `respondent` / `clerk` / `reporter`
 *     / `case`              → live /api/haystack-proxy/read (250ms debounce)
 *   - `hearingDate` / `filedAfter` / `filedBefore` / `dueBefore` / `dueAfter`
 *                            → hint ("YYYY-MM-DD"), no suggestions
 *   - `revisionSeq`          → hint ("Type a number")
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ENUM_VALUES,
  personFilterForToken,
  TOKEN_MAP,
} from '@/lib/search/haystack-query-builder';
import { read as haystackRead, gridHasError } from '@/lib/haystack-client';
import { MOTION_TYPES } from '@/lib/filings/motion-types';

// ---------------------------------------------------------------------------
// Public types

export interface ActiveToken {
  /** Surface token (e.g. `motionType`, `judge`). Always a key in TOKEN_MAP. */
  prefix: string;
  /** What the user has typed after the colon. */
  partial: string;
  /** Text index where `<prefix>:` begins. */
  startIndex: number;
  /** Text index where the partial ends (= current cursor when typing). */
  endIndex: number;
}

/** Shape consumed by HaystackFilterInput.onPick — a fully-formed chip. */
export interface PickedSuggestion {
  /** Display label rendered in the chip. */
  label: string;
  /** Underlying chip value (id, slug, enum, or date). */
  value: string;
}

export interface ActiveTokenSuggestionsProps {
  active: ActiveToken | null;
  /** Highlighted row index (driven by parent for ↑/↓ keyboard nav). */
  highlight: number;
  /** Called when the user clicks a row OR options arrive after a query. */
  onPick(picked: PickedSuggestion): void;
  /** Surface the visible option list back to the parent for Enter-to-commit. */
  onOptionsChange(opts: PickedSuggestion[]): void;
  /** Reset the highlight when the option set changes. */
  onHighlightReset?(): void;
}

// ---------------------------------------------------------------------------
// Internal helpers — per-token-type sourcing.
//
// Each helper returns `{ options, loading, hint }`:
//   - options: ready-to-render list (also surfaced to parent via onOptionsChange)
//   - loading: spinner indicator
//   - hint: secondary text (date hint, error)

function useMotionTypeSuggestions(partial: string): {
  options: PickedSuggestion[];
  shortDocs: Map<string, string>;
  loading: false;
  hint?: string;
} {
  return useMemo(() => {
    const q = partial.trim().toLowerCase();
    const matched = MOTION_TYPES.filter((mt) => {
      if (!q) return true;
      if (mt.displayName.toLowerCase().includes(q)) return true;
      if (mt.slug.toLowerCase().includes(q)) return true;
      if (mt.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
      return false;
    }).slice(0, 50);
    const shortDocs = new Map<string, string>();
    const options = matched.map((mt) => {
      shortDocs.set(mt.slug, mt.shortDoc);
      return { label: mt.displayName, value: mt.slug };
    });
    return { options, shortDocs, loading: false };
  }, [partial]);
}

function useEnumSuggestions(token: string, partial: string): {
  options: PickedSuggestion[];
  loading: false;
} {
  return useMemo(() => {
    const list = ENUM_VALUES[token] ?? [];
    const q = partial.trim().toLowerCase();
    const opts = (q ? list.filter((v) => v.toLowerCase().includes(q)) : list).map((v) => ({
      label: v,
      value: v,
    }));
    return { options: opts, loading: false };
  }, [token, partial]);
}

/**
 * Live-query the haystack-proxy. Debounced 250ms per spec. Cancels on every
 * keystroke / token change.
 *
 * The proxy returns Hayson rows. We extract `displayName` / `name` for the
 * label and a secondary line (bar#, email, or case name).
 */
interface RemoteOption extends PickedSuggestion {
  secondary?: string;
}

function useRemoteSuggestions(
  token: string | null,
  partial: string,
  enabled: boolean,
): { options: RemoteOption[]; loading: boolean; error: string | null } {
  const [state, setState] = useState<{
    options: RemoteOption[];
    loading: boolean;
    error: string | null;
  }>({ options: [], loading: false, error: null });

  const lastKeyRef = useRef('');

  useEffect(() => {
    if (!enabled || !token) {
      setState({ options: [], loading: false, error: null });
      return;
    }
    const personFilter = personFilterForToken(token);
    const baseFilter =
      token === 'case'
        ? 'case'
        : token === 'court'
          ? 'court'
          : (personFilter ?? 'person');

    const key = `${baseFilter}|${partial}`;
    lastKeyRef.current = key;
    let cancelled = false;

    setState((s) => ({ ...s, loading: true }));
    const handle = setTimeout(async () => {
      try {
        // Courts are a small global catalogue — fetch a larger window so
        // client-side narrowing reaches the whole list (mirrors ref-picker).
        const limit = token === 'court' ? 400 : 20;
        const grid = await haystackRead({ filter: baseFilter, limit });
        if (cancelled || lastKeyRef.current !== key) return;
        const err = gridHasError(grid);
        if (err) {
          setState({ options: [], loading: false, error: err });
          return;
        }
        const rows: Array<Record<string, unknown>> = Array.isArray(grid.rows)
          ? (grid.rows as Array<Record<string, unknown>>)
          : [];
        const needle = partial.trim().toLowerCase();
        const mapped: RemoteOption[] = rows
          .map((r) => mapRow(token, r))
          .filter((m): m is RemoteOption => !!m)
          .filter((m) => {
            if (!needle) return true;
            if (m.label.toLowerCase().includes(needle)) return true;
            if (m.secondary && m.secondary.toLowerCase().includes(needle)) return true;
            if (m.value.toLowerCase().includes(needle)) return true;
            return false;
          })
          .slice(0, token === 'court' ? 20 : 12);
        setState({ options: mapped, loading: false, error: null });
      } catch (e) {
        if (cancelled) return;
        setState({
          options: [],
          loading: false,
          error: (e as Error).message ?? 'fetch failed',
        });
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [token, partial, enabled]);

  return state;
}

function mapRow(token: string, row: Record<string, unknown>): RemoteOption | null {
  const id = strField(row.id);
  if (!id) return null;
  const canonId = id.startsWith('@') ? id : `@${id}`;
  if (token === 'case') {
    const causeNo = strField(row.causeNo);
    const name = strField(row.name);
    const primary = causeNo ?? name ?? canonId;
    const secondary = causeNo && name && causeNo !== name ? name : undefined;
    return { value: canonId, label: primary, secondary };
  }
  if (token === 'court') {
    const primary =
      strField(row.shortName) ?? strField(row.name) ?? strField(row.displayName) ?? canonId;
    const secondary = strField(row.jurisdictionId) ?? strField(row.dis);
    return { value: canonId, label: primary, secondary };
  }
  // person variants
  const primary =
    strField(row.displayName) ?? strField(row.name) ?? strField(row.dis) ?? canonId;
  const secondary =
    strField(row.barNumber) ?? strField(row.email) ?? strField(row.jurisdictionId);
  return { value: canonId, label: primary, secondary };
}

function strField(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as { val?: unknown; displayName?: unknown; dis?: unknown };
    if (typeof o.val === 'string') return o.val;
    if (typeof o.displayName === 'string') return o.displayName;
    if (typeof o.dis === 'string') return o.dis;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Component

const REF_TOKENS = new Set([
  'case',
  'judge',
  'lawyer',
  'movant',
  'respondent',
  'clerk',
  'reporter',
  'court', // not in TOKEN_MAP today, but reserved
]);

const DATE_TOKENS = new Set([
  'hearingDate',
  'filedAfter',
  'filedBefore',
  'dueBefore',
  'dueAfter',
]);

export function ActiveTokenSuggestions({
  active,
  highlight,
  onPick,
  onOptionsChange,
  onHighlightReset,
}: ActiveTokenSuggestionsProps) {
  const token = active?.prefix ?? null;
  const partial = active?.partial ?? '';

  // -------------------------------------------------------------------------
  // Sourcing dispatch

  const motionType = useMotionTypeSuggestions(partial);
  const isMotionType = token === 'motionType';

  const enumToken =
    token && TOKEN_MAP[token]?.category === 'enum' && token !== 'motionType'
      ? token
      : null;
  const enumOpts = useEnumSuggestions(enumToken ?? '', partial);

  const isRefToken = token != null && REF_TOKENS.has(token);
  const remote = useRemoteSuggestions(isRefToken ? token : null, partial, isRefToken);

  const isDateToken = token != null && DATE_TOKENS.has(token);
  const isNumberToken = token != null && TOKEN_MAP[token]?.category === 'number';

  // -------------------------------------------------------------------------
  // Bubble the visible option list up to the parent so it can handle Enter.

  const options: PickedSuggestion[] = useMemo(() => {
    if (!token) return [];
    if (isMotionType) return motionType.options;
    if (enumToken) return enumOpts.options;
    if (isRefToken) return remote.options;
    return [];
  }, [token, isMotionType, motionType.options, enumToken, enumOpts.options, isRefToken, remote.options]);

  // Reset highlight when the option set actually changes (length OR contents).
  const lastSig = useRef('');
  useEffect(() => {
    const sig = options.map((o) => o.value).join('|');
    if (sig !== lastSig.current) {
      lastSig.current = sig;
      onHighlightReset?.();
    }
    onOptionsChange(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  if (!token) return null;

  // -------------------------------------------------------------------------
  // Render

  const def = TOKEN_MAP[token];
  const headerLabel =
    isMotionType
      ? 'Motion type'
      : enumToken
        ? `${token} (enum)`
        : isRefToken
          ? token === 'case'
            ? 'Case'
            : token === 'court'
              ? 'Court'
              : `Person · ${personFilterForToken(token) ?? 'person'}`
          : isDateToken
            ? 'Date'
            : isNumberToken
              ? 'Number'
              : token;

  return (
    <aside
      className="w-[300px] shrink-0 border-r border-gray-200 bg-white overflow-y-auto flex flex-col"
      aria-label="Active token suggestions"
    >
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-800">
          <span className="font-mono text-purple-700">{token}:</span>
          <span className="ml-1.5 text-gray-700">{partial || '…'}</span>
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          {headerLabel}
          {def && (
            <span className="ml-1 text-gray-400">· {def.category}</span>
          )}
        </p>
      </div>

      {/* Date / number / unsupported tokens — just hint, no list. */}
      {isDateToken && (
        <div className="px-4 py-3 text-xs text-gray-600">
          Type a date as <span className="font-mono">YYYY-MM-DD</span>, or a
          range <span className="font-mono">YYYY-MM-DD..YYYY-MM-DD</span>, then
          press <kbd className="px-1.5 py-0.5 border border-gray-200 rounded text-[10px] bg-gray-50">Enter</kbd> to commit.
        </div>
      )}
      {isNumberToken && (
        <div className="px-4 py-3 text-xs text-gray-600">
          Type a number, then press{' '}
          <kbd className="px-1.5 py-0.5 border border-gray-200 rounded text-[10px] bg-gray-50">
            Enter
          </kbd>{' '}
          to commit.
        </div>
      )}

      {/* motionType — 107-row catalogue, scrollable */}
      {isMotionType && (
        <div className="flex-1 overflow-y-auto">
          {motionType.options.length === 0 ? (
            <div className="px-4 py-2 text-xs text-gray-500">No matches.</div>
          ) : (
            <ul className="py-1">
              {motionType.options.map((opt, i) => {
                const shortDoc = motionType.shortDocs.get(opt.value);
                return (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault(); // keep focus in the input
                        onPick(opt);
                      }}
                      className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-purple-50 ${
                        i === highlight ? 'bg-purple-100' : ''
                      }`}
                    >
                      <div className="font-medium text-gray-800 leading-snug">
                        {opt.label}
                      </div>
                      {shortDoc && (
                        <div className="text-[10px] text-gray-500 leading-snug mt-0.5">
                          {shortDoc}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Plain enums (kind / attachmentKind) — short list */}
      {enumToken && (
        <div className="flex-1 overflow-y-auto">
          {enumOpts.options.length === 0 ? (
            <div className="px-4 py-2 text-xs text-gray-500">No matches.</div>
          ) : (
            <ul className="py-1">
              {enumOpts.options.map((opt, i) => (
                <li key={opt.value}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick(opt);
                    }}
                    className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-purple-50 ${
                      i === highlight ? 'bg-purple-100' : ''
                    }`}
                  >
                    <span className="font-mono text-gray-800">{opt.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Refs (person / case / court) — live haystack-proxy */}
      {isRefToken && (
        <div className="flex-1 overflow-y-auto">
          {remote.loading && (
            <div className="px-4 py-2 text-[11px] text-gray-400">Loading…</div>
          )}
          {!remote.loading && remote.error && (
            <div className="px-4 py-2 text-[11px] text-red-600">
              Lookup failed: {remote.error}
            </div>
          )}
          {!remote.loading && !remote.error && remote.options.length === 0 && (
            <div className="px-4 py-2 text-xs text-gray-500">
              {partial ? 'No matches.' : 'Type to search…'}
            </div>
          )}
          <ul className="py-1">
            {remote.options.map((opt, i) => (
              <li key={opt.value}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPick(opt);
                  }}
                  className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-purple-50 ${
                    i === highlight ? 'bg-purple-100' : ''
                  }`}
                >
                  <div className="font-medium text-gray-800 leading-snug">
                    {opt.label}
                  </div>
                  {opt.secondary && (
                    <div className="text-[10px] text-gray-500 leading-snug mt-0.5">
                      {opt.secondary}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Pure helper — exported for HaystackFilterInput's cursor detection.

/**
 * Detect whether the cursor is inside a `<token>:partial` segment.
 *
 * Slices `text` up to `cursor`, then matches the trailing
 * `\w+:[^\s]*` pattern. Returns null when the cursor isn't in a recognized
 * token, or when the token isn't a key of TOKEN_MAP.
 *
 * Implementation: anchored to end-of-slice so the typical "user typed
 * judge:rob<cursor>" case works exactly as before. Plain end-of-string
 * behavior emerges when `cursor === text.length`.
 */
export function activeTokenAtCursor(text: string, cursor: number): ActiveToken | null {
  const slice = text.slice(0, cursor);
  const m = slice.match(/(?:^|\s)(\w+):([^\s]*)$/);
  if (!m) return null;
  const prefix = m[1];
  if (!TOKEN_MAP[prefix]) return null;
  const partial = m[2];
  // Compute the start index of `prefix:` (skip the leading whitespace match).
  const matchedAt = m.index ?? 0;
  const offset = m[0].startsWith(' ') ? 1 : 0;
  const startIndex = matchedAt + offset;
  const endIndex = cursor;
  return { prefix, partial, startIndex, endIndex };
}
