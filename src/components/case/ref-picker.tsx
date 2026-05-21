'use client';

/**
 * RefPicker — autofill popover for choosing a Haystack ref value.
 *
 * Replaces the plain text input that previously sat in the tag-panel for
 * tier === 'ref' / 'refs' rows. Queries the same-origin Haystack proxy
 * (/api/haystack-proxy/read via the typed client) for candidate entities
 * and surfaces them as a keyboard-navigable list. Degrades to a manual
 * `@id` input when the proxy is unavailable / unauthorized.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { read as haystackRead, gridHasError, type HaysonGrid } from '@/lib/haystack-client';
import { pickAnchor } from './popup-anchor';

export type RefTarget =
  | 'person'
  | 'motion'
  | 'case'
  | 'court'
  | 'hearing'
  | 'doc'
  | 'motionAttachment';

export type PersonMarker =
  | 'judge'
  | 'lawyer'
  | 'courtClerk'
  | 'courtReporter'
  | 'self';

export interface RefPickerProps {
  refTarget: RefTarget;
  /** Multi-select for list-valued refs (judgeRefs, plaintiffRefs, etc.). */
  multi?: boolean;
  /** Constrain person results to a sub-marker (e.g., 'judge' or 'lawyer'). */
  personMarker?: PersonMarker;
  /** Additional Haystack filter to AND into the entity query. */
  scopeFilter?: string;
  /** Current value. For multi, an array of '@<id>' strings. */
  value: string | string[] | null;
  onChange(next: string | string[] | null): void;
  onClose(): void;
  /** Anchor element rect so the popover can position itself. */
  anchorRect?: DOMRect | null;
}

// ---------------------------------------------------------------------------
// Result row shape

interface RefResult {
  id: string; // canonical '@<id>'
  primary: string;
  secondary?: string;
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Filter construction

function baseFilterFor(refTarget: RefTarget, personMarker?: PersonMarker): string {
  switch (refTarget) {
    case 'person':
      return personMarker ? `person and ${personMarker}` : 'person';
    case 'motion':
      return 'motion';
    case 'case':
      return 'case';
    case 'court':
      return 'court';
    case 'hearing':
      return 'hearing';
    case 'doc':
    case 'motionAttachment':
      return 'attachment';
  }
}

function composeFilter(
  refTarget: RefTarget,
  personMarker?: PersonMarker,
  scopeFilter?: string,
): string {
  const base = baseFilterFor(refTarget, personMarker);
  if (scopeFilter && scopeFilter.trim()) {
    return `${base} and ${scopeFilter.trim()}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Module-level LRU-ish cache (60s TTL, 50 entries)

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 50;

interface CacheEntry {
  ts: number;
  results: RefResult[];
}

const RESULT_CACHE: Map<string, CacheEntry> = new Map();

function cacheKey(
  refTarget: RefTarget,
  personMarker: PersonMarker | undefined,
  scopeFilter: string | undefined,
  q: string,
): string {
  return `${refTarget}|${personMarker ?? ''}|${scopeFilter ?? ''}|${q}`;
}

function cacheGet(key: string): RefResult[] | null {
  const ent = RESULT_CACHE.get(key);
  if (!ent) return null;
  if (Date.now() - ent.ts > CACHE_TTL_MS) {
    RESULT_CACHE.delete(key);
    return null;
  }
  // refresh LRU order
  RESULT_CACHE.delete(key);
  RESULT_CACHE.set(key, ent);
  return ent.results;
}

function cachePut(key: string, results: RefResult[]): void {
  RESULT_CACHE.set(key, { ts: Date.now(), results });
  while (RESULT_CACHE.size > CACHE_MAX) {
    const first = RESULT_CACHE.keys().next().value;
    if (first === undefined) break;
    RESULT_CACHE.delete(first);
  }
}

// Exposed for tests.
export function __clearRefPickerCache(): void {
  RESULT_CACHE.clear();
}

// ---------------------------------------------------------------------------
// Row labelling

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as { val?: unknown; displayName?: unknown };
    if (typeof o.val === 'string') return o.val;
    if (typeof o.displayName === 'string') return o.displayName;
  }
  return undefined;
}

function canonId(raw: unknown): string {
  const s = asString(raw) ?? '';
  if (!s) return '';
  return s.startsWith('@') ? s : `@${s}`;
}

function labelRow(refTarget: RefTarget, row: Record<string, unknown>): RefResult {
  const id = canonId(row.id);
  switch (refTarget) {
    case 'person': {
      const primary = asString(row.displayName) ?? asString(row.name) ?? id;
      const secondary =
        asString(row.barNumber) ??
        asString(row.email) ??
        asString(row.jurisdictionId);
      return { id, primary, secondary, raw: row };
    }
    case 'motion': {
      const primary = asString(row.motionType) ?? asString(row.name) ?? id;
      const causeNo = asString(row.causeNo);
      const caseLabel = asString(row.caseRef);
      const secondary = causeNo ? ` · ${causeNo}` : caseLabel ? ` · ${caseLabel}` : undefined;
      return {
        id,
        primary,
        secondary: secondary ? secondary.replace(/^ · /, '') : undefined,
        raw: row,
      };
    }
    case 'case': {
      const primary = asString(row.causeNo) ?? asString(row.name) ?? id;
      const secondary = asString(row.name);
      return {
        id,
        primary,
        secondary: secondary && secondary !== primary ? secondary : undefined,
        raw: row,
      };
    }
    case 'court':
    case 'hearing':
    case 'doc':
    case 'motionAttachment':
    default: {
      const primary =
        asString(row.displayName) ??
        asString(row.name) ??
        asString(row.label) ??
        id;
      const secondary =
        asString(row.dis) ??
        asString(row.kind) ??
        asString(row.location);
      return { id, primary, secondary, raw: row };
    }
  }
}

function clientSideQueryMatch(r: RefResult, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (r.primary.toLowerCase().includes(needle)) return true;
  if (r.secondary && r.secondary.toLowerCase().includes(needle)) return true;
  if (r.id.toLowerCase().includes(needle)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Fetcher

export interface FetchOutcome {
  results: RefResult[];
  /** True iff the proxy returned 401/403 (bearer auth not wired). */
  unauthorized: boolean;
}

async function fetchResults(
  refTarget: RefTarget,
  personMarker: PersonMarker | undefined,
  scopeFilter: string | undefined,
  q: string,
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  const filter = composeFilter(refTarget, personMarker, scopeFilter);
  try {
    // Route through the same-origin proxy via the typed client. The proxy
    // attaches the bearer auth server-side; the browser never sees the key.
    // haystackRead has no AbortSignal hook, but the outer effect still drops
    // stale results via ctl.signal.aborted before applying them.
    const grid: HaysonGrid = await haystackRead({ filter, limit: 24 });
    if (signal?.aborted) {
      return { results: [], unauthorized: false };
    }
    const err = gridHasError(grid);
    if (err) {
      // Domain-level err from haystack — treat as empty, not unauthorized.
      return { results: [], unauthorized: false };
    }
    const rows: Record<string, unknown>[] = Array.isArray(grid.rows)
      ? (grid.rows as Record<string, unknown>[])
      : [];
    const mapped = rows.map((r) => labelRow(refTarget, r));
    // Client-side narrow by q so the user can type to filter the cached set.
    const narrowed = q ? mapped.filter((m) => clientSideQueryMatch(m, q)) : mapped;
    return { results: narrowed.slice(0, 8), unauthorized: false };
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') {
      return { results: [], unauthorized: false };
    }
    // jsonFetch throws "Haystack <url> → HTTP <status>" — detect 401/403 to
    // light up the manual-typing fallback so the user knows it's an env issue.
    const msg = (e as { message?: string })?.message ?? '';
    if (/HTTP 401\b/.test(msg) || /HTTP 403\b/.test(msg)) {
      return { results: [], unauthorized: true };
    }
    return { results: [], unauthorized: false };
  }
}

// ---------------------------------------------------------------------------
// Position helpers

interface Pos {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  centered: boolean;
}

const POPOVER_W = 360;
const POPOVER_MAX_H = 420;

function computePos(anchorRect: DOMRect | null | undefined): Pos {
  if (typeof window === 'undefined') {
    return { top: 0, left: 0, width: POPOVER_W, maxHeight: POPOVER_MAX_H, centered: false };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Narrow viewport — center modal-style.
  if (!anchorRect || vw < 480) {
    return {
      top: Math.max(16, (vh - POPOVER_MAX_H) / 2),
      left: Math.max(8, (vw - Math.min(POPOVER_W, vw - 16)) / 2),
      width: Math.min(POPOVER_W, vw - 16),
      maxHeight: Math.min(POPOVER_MAX_H, vh - 32),
      centered: true,
    };
  }
  // Use the shared anchor picker so RefPicker, MotionTypePicker and
  // MarkerPicker stay consistent: flip horizontal if there's not enough
  // room to the right (the right-edge tag-panel case), flip vertical if
  // not enough room below.
  const anchor = pickAnchor(anchorRect, POPOVER_W, POPOVER_MAX_H);
  const spaceBelow = vh - anchorRect.bottom;
  const spaceAbove = anchorRect.top;
  const flipUp = anchor.vertical === 'above';
  const maxHeight = Math.min(
    POPOVER_MAX_H,
    Math.max(160, flipUp ? spaceAbove - 12 : spaceBelow - 12),
  );
  const top = flipUp
    ? Math.max(8, anchorRect.top - maxHeight - 4)
    : anchorRect.bottom + 4;
  // Horizontal: 'left' anchors popover's LEFT edge to input.left;
  // 'right' anchors popover's RIGHT edge to input.right (popover grows
  // leftward). Clamp to keep at least an 8px viewport margin.
  let left =
    anchor.horizontal === 'left'
      ? anchorRect.left
      : anchorRect.right - POPOVER_W;
  if (left + POPOVER_W > vw - 8) left = vw - POPOVER_W - 8;
  if (left < 8) left = 8;
  return { top, left, width: POPOVER_W, maxHeight, centered: false };
}

// ---------------------------------------------------------------------------
// Value helpers

function currentChips(value: string | string[] | null, multi: boolean | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (multi) return value ? [value] : [];
  return value ? [value] : [];
}

function addToValue(
  value: string | string[] | null,
  id: string,
  multi: boolean | undefined,
): string | string[] | null {
  if (!multi) return id;
  const cur = Array.isArray(value) ? value : value ? [value] : [];
  if (cur.includes(id)) return cur;
  return [...cur, id];
}

function removeFromValue(
  value: string | string[] | null,
  id: string,
  multi: boolean | undefined,
): string | string[] | null {
  if (!multi) {
    return value === id ? null : value;
  }
  const cur = Array.isArray(value) ? value : value ? [value] : [];
  const next = cur.filter((v) => v !== id);
  return next.length ? next : null;
}

// ---------------------------------------------------------------------------
// Component

export function RefPicker({
  refTarget,
  multi,
  personMarker,
  scopeFilter,
  value,
  onChange,
  onClose,
  anchorRect,
}: RefPickerProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<RefResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Bump on window resize so `pos` recomputes for viewport changes.
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const onResize = () => setResizeTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const pos = useMemo(
    () => computePos(anchorRect ?? null),
    // resizeTick is intentional — its only purpose is to invalidate the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchorRect, resizeTick],
  );
  const chips = currentChips(value, multi);

  // Debounce
  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(query), 200);
    return () => window.clearTimeout(h);
  }, [query]);

  // Autofocus
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fetch on debounced query change
  useEffect(() => {
    const key = cacheKey(refTarget, personMarker, scopeFilter, debounced);
    const cached = cacheGet(key);
    if (cached) {
      setResults(cached);
      setHighlight(0);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    fetchResults(refTarget, personMarker, scopeFilter, debounced, ctl.signal)
      .then((out) => {
        if (ctl.signal.aborted) return;
        setUnauthorized(out.unauthorized);
        setResults(out.results);
        setHighlight(0);
        if (!out.unauthorized) cachePut(key, out.results);
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
  }, [refTarget, personMarker, scopeFilter, debounced]);

  // Click-outside
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!popRef.current) return;
      if (e.target instanceof Node && !popRef.current.contains(e.target)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  const select = useCallback(
    (id: string) => {
      if (!id) return;
      const next = addToValue(value, id, multi);
      onChange(next);
      if (multi) {
        setQuery('');
      } else {
        onClose();
      }
    },
    [value, multi, onChange, onClose],
  );

  const removeChip = useCallback(
    (id: string) => {
      onChange(removeFromValue(value, id, multi));
    },
    [value, multi, onChange],
  );

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Backspace' && query === '' && chips.length > 0) {
        e.preventDefault();
        removeChip(chips[chips.length - 1]);
        return;
      }
      if (unauthorized) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const typed = query.trim();
          if (!typed) return;
          const id = typed.startsWith('@') ? typed : `@${typed}`;
          select(id);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(results.length - 1, h + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const r = results[highlight];
        if (r) select(r.id);
        else if (query.trim()) {
          const typed = query.trim();
          const id = typed.startsWith('@') ? typed : `@${typed}`;
          select(id);
        }
      }
    },
    [query, chips, removeChip, unauthorized, results, highlight, select, onClose],
  );

  const placeholderHint = unauthorized
    ? `@${refTarget}-…  (type and press Enter)`
    : `Search ${refTarget}…`;

  const popStyle: React.CSSProperties = pos.centered
    ? {
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        zIndex: 60,
      }
    : {
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        zIndex: 60,
      };

  return (
    <div
      ref={popRef}
      style={popStyle}
      role="dialog"
      aria-label={`Pick ${refTarget} reference`}
      className="bg-white border border-gray-200 rounded-lg shadow-lg flex flex-col overflow-hidden"
    >
      {/* Header / current value */}
      <div className="px-2 py-1.5 border-b border-gray-100 bg-gray-50">
        {multi ? (
          chips.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {chips.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-blue-100 text-blue-800 border border-blue-200"
                >
                  <span className="truncate max-w-[200px]">{c}</span>
                  <button
                    type="button"
                    onClick={() => removeChip(c)}
                    className="text-blue-600 hover:text-blue-900 leading-none"
                    aria-label={`Remove ${c}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-gray-400">No references yet.</div>
          )
        ) : (
          <div className="text-[10px] text-gray-500 truncate">
            {chips.length > 0 ? <>Currently: <span className="text-blue-700">{chips[0]}</span></> : 'No reference set.'}
          </div>
        )}
      </div>

      {/* Auth warning */}
      {unauthorized && (
        <div className="px-2 py-1.5 text-[11px] text-amber-800 bg-amber-50 border-b border-amber-200">
          Bearer auth not configured — type the ref manually below.
        </div>
      )}

      {/* Input */}
      <div className="px-2 py-1.5 border-b border-gray-100">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholderHint}
          className="w-full px-2 py-1 border border-gray-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {unauthorized ? (
          <div className="p-3 text-[11px] text-gray-500">
            Enter format: <code>@{refTarget}-...</code> then press Enter.
          </div>
        ) : loading && results.length === 0 ? (
          <div className="p-3 text-[11px] text-gray-400">Searching…</div>
        ) : results.length === 0 ? (
          <div className="p-3 text-[11px] text-gray-400">
            {debounced ? 'No matches.' : 'Start typing to search.'}
          </div>
        ) : (
          <ul className="py-1">
            {results.map((r, i) => (
              <li key={r.id + i}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => select(r.id)}
                  className={`w-full text-left px-2 py-1 flex flex-col gap-0.5 ${
                    i === highlight ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="text-[12px] text-gray-900 truncate">{r.primary}</span>
                  {r.secondary && (
                    <span className="text-[10px] text-gray-500 truncate">{r.secondary}</span>
                  )}
                  <span className="text-[10px] text-gray-400 truncate">{r.id}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer hint */}
      <div className="px-2 py-1 text-[10px] text-gray-400 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
        <span>↑/↓ navigate · Enter add · Esc close</span>
        {multi && <span>multi-select</span>}
      </div>
    </div>
  );
}

export default RefPicker;
