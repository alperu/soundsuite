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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ENUM_VALUES,
  personFilterForToken,
  TOKEN_MAP,
} from '@/lib/search/haystack-query-builder';
import { read as haystackRead, gridHasError } from '@/lib/haystack-client';
import { MOTION_TYPES } from '@/lib/filings/motion-types';

// ---------------------------------------------------------------------------
// Public types

export type ActiveTokenOp = '==' | '!=' | '>=' | '<=' | '>' | '<';

export interface ActiveToken {
  /**
   * Surface token path joined with `->` (e.g. `motionType`, `judge`,
   * `reporterRef->displayName`). For backward compatibility this stays the
   * same field name; the first segment is always a key in TOKEN_MAP.
   */
  prefix: string;
  /**
   * Path split on `->`. `prefix === path.join('->')`. Length 1 = single-segment
   * (the legacy / common case); length > 1 = path traversal like
   * `reporterRef->displayName`.
   */
  path: string[];
  /** What the user has typed after the operator. */
  partial: string;
  /** The operator the user typed (`==`, `>=`, etc.). Defaults to `==` for
   *  bare-prefix Ctrl+Space invocations. */
  op: ActiveTokenOp;
  /** Text index where `<prefix><op>` begins. */
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

/** Minimal scope chip shape passed to path-values for cascading pickers. */
export interface ScopeChipLite {
  tag: string;
  op?: string;
  value: string;
}

export interface ActiveTokenSuggestionsProps {
  active: ActiveToken | null;
  /**
   * Chips currently present in the composer. Forwarded to /api/search/path-values
   * via the `scope` query param so cascading pickers (e.g. filingRef scoped by
   * the current case==) can narrow their result set.
   */
  scope?: ScopeChipLite[];
  /** Highlighted row index (driven by parent for ↑/↓ keyboard nav). */
  highlight: number;
  /** Called when the user clicks a row OR options arrive after a query. */
  onPick(picked: PickedSuggestion): void;
  /**
   * Task #63: commit a batch of selected values, OR-joined and paren-wrapped.
   * The parent splices `( v1 or v2 ... )` chips at the caret position in one
   * `onChipsChange` so the batch is atomic w.r.t. undo/redo and re-render.
   */
  onPickMany?(picked: PickedSuggestion[]): void;
  /** Surface the visible option list back to the parent for Enter-to-commit. */
  onOptionsChange(opts: PickedSuggestion[]): void;
  /** Reset the highlight when the option set changes. */
  onHighlightReset?(): void;
  /**
   * Task #63: lifted multi-select state. Owned by the parent so the input's
   * Enter handler can commit the pending batch.
   */
  selectedValues?: Set<string>;
  onSelectedValuesChange?(next: Set<string>, anchor: string | null): void;
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

/**
 * Task #65 — path-traversal value picker. Hits /api/search/path-values which
 * resolves the last segment against Prisma (Case for `case->X`, Person for
 * `<personRef>->X`). Same debounced/cancellable pattern as
 * `useRemoteSuggestions` above.
 */
function usePathTraversalSuggestions(
  path: string[],
  partial: string,
  enabled: boolean,
  scope: ScopeChipLite[] = [],
): { options: RemoteOption[]; loading: boolean; error: string | null } {
  const [state, setState] = useState<{
    options: RemoteOption[];
    loading: boolean;
    error: string | null;
  }>({ options: [], loading: false, error: null });

  const lastKeyRef = useRef('');
  const joined = path.join('->');
  // Stable scope key — only the bits the server actually uses.
  const scopeKey = scope
    .map((c) => `${c.tag}${c.op ?? '=='}${c.value}`)
    .join(',');

  useEffect(() => {
    // path-values now also handles single-segment ref pickers (filingRef).
    // Allow length === 1 when root is a known single-segment ref root.
    const singleSegmentRefRoots = new Set(['filingRef', 'filing']);
    const isSingleSegmentRef = path.length === 1 && singleSegmentRefRoots.has(path[0]);
    if (!enabled || (path.length < 2 && !isSingleSegmentRef)) {
      setState({ options: [], loading: false, error: null });
      return;
    }
    const key = `${joined}|${partial}|${scopeKey}`;
    lastKeyRef.current = key;
    let cancelled = false;

    setState((s) => ({ ...s, loading: true }));
    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          path: joined,
          prefix: partial,
          limit: '20',
        });
        if (scope.length > 0) params.set('scope', JSON.stringify(scope));
        const res = await fetch(`/api/search/path-values?${params.toString()}`);
        if (cancelled || lastKeyRef.current !== key) return;
        if (!res.ok) {
          setState({
            options: [],
            loading: false,
            error: `HTTP ${res.status}`,
          });
          return;
        }
        const json = (await res.json()) as {
          options?: Array<{
            value: string;
            label: string;
            secondary?: string;
            id?: string;
          }>;
          error?: string;
        };
        if (json.error) {
          setState({ options: [], loading: false, error: json.error });
          return;
        }
        const mapped: RemoteOption[] = (json.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
          secondary: o.secondary,
        }));
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
  }, [joined, partial, enabled, path.length, scopeKey]);

  return state;
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
  scope = [],
  highlight,
  onPick,
  onPickMany,
  onOptionsChange,
  onHighlightReset,
  selectedValues,
  onSelectedValuesChange,
}: ActiveTokenSuggestionsProps) {
  // Anchor for shift+click range select. Kept local — the parent only cares
  // about which values are selected, not the anchor.
  const anchorRef = useRef<string | null>(null);

  // Reset multi-selection when the active token disappears.
  useEffect(() => {
    if (!active && selectedValues && selectedValues.size > 0) {
      onSelectedValuesChange?.(new Set(), null);
      anchorRef.current = null;
    }
  }, [active, selectedValues, onSelectedValuesChange]);

  // Helper: row-click dispatcher used by every option row. Honors
  // Shift/Ctrl/Cmd modifiers for range / toggle selection; plain click clears
  // any pending multi-selection and commits the single value.
  const onRowClick = useCallback(
    (
      e: React.MouseEvent,
      opt: PickedSuggestion,
      orderedValues: string[],
    ) => {
      e.preventDefault();
      if (e.shiftKey && anchorRef.current && onSelectedValuesChange) {
        // Range select from anchor to clicked value (inclusive).
        const a = orderedValues.indexOf(anchorRef.current);
        const b = orderedValues.indexOf(opt.value);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const next = new Set(selectedValues ?? []);
          for (let i = lo; i <= hi; i++) next.add(orderedValues[i]);
          onSelectedValuesChange(next, opt.value);
          return;
        }
      }
      if ((e.metaKey || e.ctrlKey) && onSelectedValuesChange) {
        const next = new Set(selectedValues ?? []);
        if (next.has(opt.value)) next.delete(opt.value);
        else next.add(opt.value);
        anchorRef.current = opt.value;
        onSelectedValuesChange(next, opt.value);
        return;
      }
      // Plain click — clear multi-selection and commit single value.
      if (selectedValues && selectedValues.size > 0) {
        onSelectedValuesChange?.(new Set(), null);
        anchorRef.current = null;
      }
      onPick(opt);
    },
    [onPick, onSelectedValuesChange, selectedValues],
  );

  // Commit the pending multi-selection as a batch (Add-N-filters button).
  const commitMultiSelection = useCallback(() => {
    if (!selectedValues || selectedValues.size === 0) return;
    if (!onPickMany) return;
    // Preserve the visible-list order so the resulting chip OR-chain reads
    // left-to-right as the user saw it.
    const orderedOpts: PickedSuggestion[] = [];
    // We have the option list mirrored upstream via onOptionsChange, but we
    // also need it here. Closure over `optionsRef` (set just before render).
    // Use the latest emitted list captured below.
    const list = lastOptionsRef.current;
    for (const opt of list) {
      if (selectedValues.has(opt.value)) orderedOpts.push(opt);
    }
    if (orderedOpts.length === 0) return;
    onPickMany(orderedOpts);
    onSelectedValuesChange?.(new Set(), null);
    anchorRef.current = null;
  }, [selectedValues, onPickMany, onSelectedValuesChange]);

  // Mirror the last-emitted option list so `commitMultiSelection` can read
  // it without a re-render dependency cycle.
  const lastOptionsRef = useRef<PickedSuggestion[]>([]);

  const path = active?.path ?? [];
  const token = active ? path[0] ?? null : null;
  const partial = active?.partial ?? '';
  // Task #65: multi-segment paths (`reporterRef->displayName`) route through
  // /api/search/path-values instead of the haystack-proxy person/case picker.
  // Single-segment `filingRef` also uses the path-values endpoint (with the
  // current chips passed as `scope` so the picker can cascade on case==).
  const isSingleSegmentPathRoot = active != null && path.length === 1
    && (path[0] === 'filingRef' || path[0] === 'filing');
  const isPathTraversal = active != null && (path.length > 1 || isSingleSegmentPathRoot);

  // -------------------------------------------------------------------------
  // Sourcing dispatch

  const motionType = useMotionTypeSuggestions(partial);
  const isMotionType = !isPathTraversal && token === 'motionType';

  const enumToken =
    !isPathTraversal && token && TOKEN_MAP[token]?.category === 'enum' && token !== 'motionType'
      ? token
      : null;
  const enumOpts = useEnumSuggestions(enumToken ?? '', partial);

  const isRefToken = !isPathTraversal && token != null && REF_TOKENS.has(token);
  const remote = useRemoteSuggestions(isRefToken ? token : null, partial, isRefToken);

  const pathRemote = usePathTraversalSuggestions(path, partial, isPathTraversal, scope);

  const isDateToken = !isPathTraversal && token != null && DATE_TOKENS.has(token);
  const isNumberToken = !isPathTraversal && token != null && TOKEN_MAP[token]?.category === 'number';

  // -------------------------------------------------------------------------
  // Bubble the visible option list up to the parent so it can handle Enter.

  const options: PickedSuggestion[] = useMemo(() => {
    if (!token) return [];
    if (isPathTraversal) return pathRemote.options;
    if (isMotionType) return motionType.options;
    if (enumToken) return enumOpts.options;
    if (isRefToken) return remote.options;
    return [];
  }, [token, isPathTraversal, pathRemote.options, isMotionType, motionType.options, enumToken, enumOpts.options, isRefToken, remote.options]);

  // Reset highlight when the option set actually changes (length OR contents).
  const lastSig = useRef('');
  useEffect(() => {
    const sig = options.map((o) => o.value).join('|');
    if (sig !== lastSig.current) {
      lastSig.current = sig;
      onHighlightReset?.();
    }
    lastOptionsRef.current = options;
    onOptionsChange(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  if (!token) return null;

  // -------------------------------------------------------------------------
  // Render

  const def = TOKEN_MAP[token];
  const headerLabel = isPathTraversal
    ? `Path · ${path.join(' → ')}`
    : isMotionType
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
          <span className="font-mono text-purple-700">
            {isPathTraversal ? path.join('->') : token}
            {active?.op ? active.op : '=='}
          </span>
          <span className="ml-1.5 text-gray-700">{partial || '…'}</span>
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          {headerLabel}
          {def && (
            <span className="ml-1 text-gray-400">· {def.category}</span>
          )}
        </p>
      </div>

      {/* Task #63: multi-select summary + commit button. Visible when the
          user has Ctrl/Cmd-clicked or Shift+clicked at least one row. The
          button OR-joins all selected values, paren-wrapped, and splices the
          batch at the caret position. */}
      {selectedValues && selectedValues.size > 0 && onPickMany && (
        <div className="px-3 py-2 border-b border-purple-200 bg-purple-50/70 flex items-center justify-between gap-2">
          <span className="text-[11px] text-purple-700">
            {selectedValues.size} value{selectedValues.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelectedValuesChange?.(new Set(), null);
                anchorRef.current = null;
              }}
              className="text-[10px] text-gray-500 hover:text-gray-800 px-1.5 py-0.5"
              aria-label="Clear selection"
            >
              clear
            </button>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commitMultiSelection();
              }}
              className="text-[11px] font-medium px-2 py-0.5 rounded border border-purple-400 bg-white text-purple-700 hover:bg-purple-100"
              aria-label={`Add ${selectedValues.size} filters joined with or`}
            >
              Add {selectedValues.size} (or)
            </button>
          </div>
        </div>
      )}

      {/* Date tokens — native date picker plus a hint for ranges. */}
      {isDateToken && (
        <div className="px-4 py-3 text-xs text-gray-600 space-y-2">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-gray-500">Pick a date</span>
            <input
              type="date"
              className="mt-1 block w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-500/30"
              defaultValue={/^\d{4}-\d{2}-\d{2}$/.test(partial) ? partial : ''}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const v = e.target.value;
                if (v) onPick({ value: v, label: v });
              }}
            />
          </label>
          <p className="leading-snug text-[11px] text-gray-500">
            Or type <span className="font-mono">YYYY-MM-DD</span> / range
            <span className="font-mono"> YYYY-MM-DD..YYYY-MM-DD</span> and press{' '}
            <kbd className="px-1.5 py-0.5 border border-gray-200 rounded text-[10px] bg-gray-50">Enter</kbd>.
          </p>
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

      {/* Task #65: path-traversal — Person/Case attribute lookup via Prisma */}
      {isPathTraversal && (
        <div className="flex-1 overflow-y-auto">
          {pathRemote.loading && (
            <div className="px-4 py-2 text-[11px] text-gray-400">Loading…</div>
          )}
          {!pathRemote.loading && pathRemote.error && (
            <div className="px-4 py-2 text-[11px] text-red-600">
              Lookup failed: {pathRemote.error}
            </div>
          )}
          {!pathRemote.loading && !pathRemote.error && pathRemote.options.length === 0 && (
            <div className="px-4 py-2 text-xs text-gray-500">
              {partial ? 'No matches.' : 'Type to search…'}
            </div>
          )}
          <ul className="py-1">
            {pathRemote.options.map((opt, i) => {
              const isSel = selectedValues?.has(opt.value) ?? false;
              const orderedValues = pathRemote.options.map((o) => o.value);
              return (
                <li key={`pt-${opt.value}-${i}`}>
                  <button
                    type="button"
                    onMouseDown={(e) => onRowClick(e, opt, orderedValues)}
                    className={`flex items-start gap-2 w-full text-left px-3 py-1.5 text-xs hover:bg-purple-50 ${
                      isSel ? 'bg-purple-50' : ''
                    } ${i === highlight ? 'bg-purple-100' : ''}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 inline-flex w-3 h-3 rounded-sm border ${
                        isSel
                          ? 'bg-purple-600 border-purple-600 text-white items-center justify-center'
                          : 'border-gray-300'
                      }`}
                    >
                      {isSel && (
                        <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path d="M2 6 L5 9 L10 3" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="flex-1 min-w-0">
                      <div className="font-medium text-gray-800 leading-snug truncate">
                        {opt.label}
                      </div>
                      {opt.secondary && (
                        <div className="text-[10px] text-gray-500 leading-snug mt-0.5 truncate">
                          {opt.secondary}
                        </div>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
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
            {remote.options.map((opt, i) => {
              const isSel = selectedValues?.has(opt.value) ?? false;
              const orderedValues = remote.options.map((o) => o.value);
              return (
                <li key={opt.value}>
                  <button
                    type="button"
                    onMouseDown={(e) => onRowClick(e, opt, orderedValues)}
                    className={`flex items-start gap-2 w-full text-left px-3 py-1.5 text-xs hover:bg-purple-50 ${
                      isSel ? 'bg-purple-50' : ''
                    } ${i === highlight ? 'bg-purple-100' : ''}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 inline-flex w-3 h-3 rounded-sm border ${
                        isSel
                          ? 'bg-purple-600 border-purple-600 text-white items-center justify-center'
                          : 'border-gray-300'
                      }`}
                    >
                      {isSel && (
                        <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path d="M2 6 L5 9 L10 3" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="flex-1 min-w-0">
                      <div className="font-medium text-gray-800 leading-snug truncate">
                        {opt.label}
                      </div>
                      {opt.secondary && (
                        <div className="text-[10px] text-gray-500 leading-snug mt-0.5 truncate">
                          {opt.secondary}
                        </div>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
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
// Roots that are recognized for path-traversal even though they're not in
// TOKEN_MAP. These are the canonical *Ref names produced by FIELD_ALIASES
// (`judge` → `judgeRef`) — the picker also fires when the user types the
// canonical form directly (`judgeRef->displayName==...`).
const PATH_ROOT_ALIASES = new Set([
  'judgeRef',
  'lawyerRef',
  'movantRef',
  'respondentRef',
  'clerkRef',
  'reporterRef',
  'caseRef',
]);

// Match `<prefix><op><partial>` where:
//   <prefix> is one or more `\w+` segments joined by `->` (Task #65 — path
//     traversal: `reporterRef->displayName`, `case->jurisdiction`, etc.)
//   <op> is any Axon comparison operator.
// `==` is the canonical equality; `>=`/`<=`/`>`/`<`/`!=` are valid for
// date/number-typed fields (`hearingDate >= 2026-04-01`). Legacy `:` no
// longer triggers the picker (per #59 it's a parse error).
const ACTIVE_TOKEN_RE = /(?:^|\s)(\w+(?:->\w+)*)\s*(==|!=|>=|<=|>|<)\s*([^\s]*)$/;

// Match a bare prefix (no operator yet) — used by the Ctrl+Space hook so
// `case<cursor>` can pop the picker without first typing `==`. Also supports
// path traversal: `reporterRef->display<cursor>`.
const BARE_PREFIX_RE = /(?:^|\s)(\w+(?:->\w+)*)$/;

export function activeTokenAtCursor(text: string, cursor: number): ActiveToken | null {
  const slice = text.slice(0, cursor);
  const m = slice.match(ACTIVE_TOKEN_RE);
  if (!m) return null;
  const prefix = m[1];
  const path = prefix.split('->');
  // First segment must be a known TOKEN_MAP key OR a canonical *Ref name
  // (Task #65). For multi-segment paths the value-source is selected by the
  // *last* segment; see the dispatcher below.
  if (!TOKEN_MAP[path[0]] && !PATH_ROOT_ALIASES.has(path[0])) return null;
  const op = m[2] as ActiveTokenOp;
  const partial = m[3];
  const matchedAt = m.index ?? 0;
  const offset = m[0].startsWith(' ') ? 1 : 0;
  const startIndex = matchedAt + offset;
  const endIndex = cursor;
  return { prefix, path, partial, op, startIndex, endIndex };
}

/**
 * Force-open the picker at the cursor — used by Ctrl+Space.
 * If the user already typed `prefix==`, behaves like `activeTokenAtCursor`.
 * If they typed just `prefix` (no operator), synthesize an ActiveToken with
 * an empty partial so the picker can offer values for the field; the caller
 * is responsible for appending `==` to the text before the partial fills in.
 */
export function forceActiveTokenAtCursor(text: string, cursor: number): ActiveToken | null {
  const primary = activeTokenAtCursor(text, cursor);
  if (primary) return primary;
  const slice = text.slice(0, cursor);
  const m = slice.match(BARE_PREFIX_RE);
  if (!m) return null;
  const prefix = m[1];
  const path = prefix.split('->');
  if (!TOKEN_MAP[path[0]] && !PATH_ROOT_ALIASES.has(path[0])) return null;
  const matchedAt = m.index ?? 0;
  const offset = m[0].startsWith(' ') ? 1 : 0;
  const startIndex = matchedAt + offset;
  // Default to the field's preferred op (e.g. date fields use `>=` for `filedAfter`)
  // and fall back to `==` for equality fields.
  const defOp = (TOKEN_MAP[path[0]]?.op ?? '==') as ActiveTokenOp;
  return { prefix, path, partial: '', op: defOp, startIndex, endIndex: cursor };
}
