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
  | 'proSe'
  | 'courtClerk'
  | 'courtReporter'
  | 'self';

/** Chip set rendered above the search input for Person pickers. */
const PERSON_ROLE_CHIPS: { marker: PersonMarker; label: string }[] = [
  { marker: 'lawyer', label: 'Lawyer' },
  { marker: 'proSe', label: 'Pro Se' },
  { marker: 'judge', label: 'Judge' },
  { marker: 'courtClerk', label: 'Court Clerk' },
  { marker: 'courtReporter', label: 'Court Reporter' },
];

export interface RefPickerProps {
  refTarget: RefTarget;
  /** Multi-select for list-valued refs (judgeRefs, plaintiffRefs, etc.). */
  multi?: boolean;
  /**
   * Initial Person sub-marker pre-toggled in the chip row. The user can
   * untoggle it to broaden the search, or add more chips for AND-narrowing.
   * Still supported as a single value for back-compat with callers that
   * haven't migrated to multi-role yet.
   */
  personMarker?: PersonMarker;
  /** Additional Haystack filter to AND into the entity query. */
  scopeFilter?: string;
  /**
   * Client-side scope: canonical '@<caseId>' to restrict results to rows whose
   * synthesized `caseRef` equals this id. Used for motion/doc/motionAttachment/
   * hearing pickers that should only surface entities in the current case.
   *
   * We filter client-side because the underlying Motion/MotionAttachment/Hearing
   * tables store the case linkage on the `caseId` FK column, not in `tags`. The
   * Haystack filter compiler only knows about `json_extract(tags, '$.X')`, so a
   * server-side `caseRef==@<id>` clause matches zero rows. The route synthesizes
   * `caseRef` post-read from `row.caseId`, so filtering after the fetch works.
   */
  scopeCaseId?: string;
  /** Current value. For multi, an array of '@<id>' strings. */
  value: string | string[] | null;
  onChange(next: string | string[] | null): void;
  onClose(): void;
  /** Anchor element rect so the popover can position itself. */
  anchorRect?: DOMRect | null;
  /** Canonical '@<id>' values to exclude from results — e.g. the entity
   *  currently being edited shouldn't appear in its own motionRef picker. */
  excludeIds?: string[];
}

// ---------------------------------------------------------------------------
// Result row shape

interface RefResult {
  id: string; // canonical '@<id>'
  primary: string;
  secondary?: string;
  tertiary?: string;
  /** Small role-tag labels rendered inline next to `primary` (Person only). */
  badges?: string[];
  raw: Record<string, unknown>;
}

/**
 * Detect whether a Person row carries a given intrinsic marker. Markers may
 * surface in several shapes depending on whether the row came from a plain
 * Prisma row, a Hayson-serialized grid, or a merged tags-blob:
 *   - boolean true        (Prisma column / merged tag)
 *   - 'm:'                (Hayson marker literal)
 *   - { _kind: 'marker' } (decoded Hayson marker object)
 *   - { val: 'm:' }       (lightly-decoded Hayson marker)
 * We accept any of these as "present"; explicit `false`/null/undefined are absent.
 */
function hasPersonMarker(row: Record<string, unknown>, key: string): boolean {
  const direct = row[key];
  if (direct !== undefined && direct !== null && direct !== false) {
    if (direct === true) return true;
    if (typeof direct === 'string') return direct === 'm:' || direct === 'true';
    if (typeof direct === 'object') {
      const o = direct as { _kind?: unknown; val?: unknown };
      if (o._kind === 'marker') return true;
      if (typeof o.val === 'string' && o.val === 'm:') return true;
      // Any non-empty object that isn't an explicit false-ish shape counts.
      return true;
    }
  }
  // Fallback: inspect `tags` blob (object or JSON string) for the marker.
  const tags = row.tags;
  let parsed: Record<string, unknown> | null = null;
  if (tags && typeof tags === 'object') {
    parsed = tags as Record<string, unknown>;
  } else if (typeof tags === 'string') {
    try {
      const j = JSON.parse(tags);
      if (j && typeof j === 'object') parsed = j as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  if (!parsed) return false;
  const v = parsed[key];
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'string') return v === 'm:' || v === 'true';
  if (typeof v === 'object') {
    const o = v as { _kind?: unknown; val?: unknown };
    if (o._kind === 'marker') return true;
    if (typeof o.val === 'string' && o.val === 'm:') return true;
    return true;
  }
  return false;
}

const PERSON_BADGE_DEFS: { key: string; label: string }[] = [
  { key: 'lawyer', label: 'Lawyer' },
  { key: 'proSe', label: 'Pro Se' },
  { key: 'judge', label: 'Judge' },
  { key: 'courtClerk', label: 'Court Clerk' },
  { key: 'courtReporter', label: 'Court Reporter' },
];

// ---------------------------------------------------------------------------
// Filter construction

function baseFilterFor(refTarget: RefTarget, personMarkers: PersonMarker[]): string {
  switch (refTarget) {
    case 'person': {
      if (personMarkers.length === 0) return 'person';
      return `person and ${personMarkers.join(' and ')}`;
    }
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
  personMarkers: PersonMarker[],
  scopeFilter?: string,
): string {
  const base = baseFilterFor(refTarget, personMarkers);
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
  personMarkers: PersonMarker[],
  scopeFilter: string | undefined,
  scopeCaseId: string | undefined,
  courtId: string | undefined,
  q: string,
): string {
  const markers = [...personMarkers].sort().join('+');
  return `${refTarget}|${markers}|${scopeFilter ?? ''}|${scopeCaseId ?? ''}|${courtId ?? ''}|${q}`;
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

/**
 * The read endpoint resolves ref-shaped fields and inlines a sibling
 * `<refName>Label` value. That sibling is sometimes a bare string, sometimes
 * an array (for list-valued refs). Pluck the first usable string.
 */
function firstLabel(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v || undefined;
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = typeof item === 'string' ? item : asString(item);
      if (s) return s;
    }
    return undefined;
  }
  return asString(v);
}

function shortIdLabel(kind: string, id: string): string {
  // '@bbe7c991-64e9-…'  →  'Motion bbe7c991'
  const stripped = id.startsWith('@') ? id.slice(1) : id;
  const head = stripped.split('-')[0] || stripped.slice(0, 8);
  return `${kind} ${head}`;
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
      const badges = PERSON_BADGE_DEFS
        .filter((d) => hasPersonMarker(row, d.key))
        .map((d) => d.label);
      return {
        id,
        primary,
        secondary,
        badges: badges.length > 0 ? badges : undefined,
        raw: row,
      };
    }
    case 'motion': {
      // Fall back through every plausible human-readable field before giving
      // up to a UUID. Many motions in practice lack `motionType` (it's set by
      // the classifier and may not run yet) — so we try title/name/dis/label
      // and finally show a short id like "Motion bbe7c991" rather than the
      // full uuid which is unreadable.
      const primary =
        asString(row.title) ??
        asString(row.motionType) ??
        asString(row.name) ??
        asString(row.dis) ??
        asString(row.label) ??
        shortIdLabel('Motion', id);
      // Read op inlines `<refName>Label` siblings — caseRefLabel resolves to
      // the case display name so the user can tell which case the motion is
      // from at a glance.
      const caseLabel = firstLabel(row.caseRefLabel) ?? asString(row.caseRef);
      const causeNo = asString(row.causeNo);
      const filedOn = asString(row.filedOn);
      const secondary = caseLabel ?? causeNo ?? filedOn;
      const tertiary = caseLabel && causeNo && caseLabel !== causeNo ? causeNo : undefined;
      return { id, primary, secondary, tertiary, raw: row };
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
    case 'doc':
    case 'motionAttachment': {
      // For file/attachment pickers the user needs to know which filing &
      // case the document belongs to — top line = filename/title, second =
      // case label, third = file path (when available).
      const primary =
        asString(row.fileName) ??
        asString(row.title) ??
        asString(row.attachmentKind) ??
        asString(row.displayName) ??
        asString(row.name) ??
        asString(row.dis) ??
        shortIdLabel('File', id);
      const caseLabel = firstLabel(row.caseRefLabel) ?? asString(row.caseRef);
      const filePath = asString(row.filePath);
      return { id, primary, secondary: caseLabel, tertiary: filePath, raw: row };
    }
    case 'court':
    case 'hearing':
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
  if (r.tertiary && r.tertiary.toLowerCase().includes(needle)) return true;
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

/**
 * Specialized fetcher for `refTarget === 'doc'` (fileRef pickers).
 *
 * The Document table isn't reachable via the Haystack /read filter compiler
 * (`tableFromFilter` returns 'Document' for the `fileref` / `document` token,
 * but `opRead`'s switch has no Document case → "entity Document not implemented
 * in v1"). Rather than retrofit Haystack, we hit the dedicated case-scoped
 * `/api/cases/[id]/documents` endpoint here whenever a fileRef picker is
 * opened with a known case context. Returns the full Document set for the case
 * so the user can manually attach a PDF to a Filing/Motion where ingestion
 * didn't auto-link one.
 */
async function fetchDocResults(
  scopeCaseId: string,
  q: string,
): Promise<FetchOutcome> {
  try {
    // scopeCaseId arrives as canonical '@<uuid>'. Strip the sigil for the URL.
    const caseId = scopeCaseId.startsWith('@') ? scopeCaseId.slice(1) : scopeCaseId;
    const r = await fetch(`/api/cases/${encodeURIComponent(caseId)}/documents`);
    if (r.status === 401 || r.status === 403) {
      return { results: [], unauthorized: true };
    }
    if (!r.ok) return { results: [], unauthorized: false };
    const j = (await r.json()) as {
      documents?: Array<{
        id: string;
        fileName: string;
        filePath: string;
        status: string;
        pageCount: number | null;
        documentType: string | null;
        filingId: string | null;
        filingTitle: string | null;
        filingType: string | null;
      }>;
    };
    const docs = Array.isArray(j.documents) ? j.documents : [];
    const mapped: RefResult[] = docs.map((d) => {
      // Primary: human-friendly file name. Fallback to basename of filePath.
      const base = d.fileName || (d.filePath ? d.filePath.split('/').pop() : '') || d.id;
      // Secondary: filing context — the "linked to <filing>" hint. Show the
      // filing's title (and type) when available so the user can tell which
      // filing each Document already belongs to even when picking from a
      // different filing/motion.
      const filingLabel = d.filingTitle
        ? `linked to: ${d.filingTitle}${d.filingType ? ` (${d.filingType})` : ''}`
        : 'unlinked';
      // Tertiary: page count + status, plus a tail of the path for disambiguation
      // when filenames collide (common with multi-volume RR scans).
      const pageBit = d.pageCount != null ? `${d.pageCount}p` : null;
      const statusBit = d.status && d.status !== 'INDEXED' ? d.status : null;
      const pathTail = d.filePath ? `…${d.filePath.slice(-40)}` : null;
      const tertiary = [pageBit, statusBit, pathTail].filter(Boolean).join(' · ') || undefined;
      return {
        id: `@${d.id}`,
        primary: base,
        secondary: filingLabel,
        tertiary,
        raw: d as unknown as Record<string, unknown>,
      };
    });
    const narrowed = q ? mapped.filter((m) => clientSideQueryMatch(m, q)) : mapped;
    return { results: narrowed.slice(0, 50), unauthorized: false };
  } catch {
    return { results: [], unauthorized: false };
  }
}

async function fetchResults(
  refTarget: RefTarget,
  personMarkers: PersonMarker[],
  scopeFilter: string | undefined,
  scopeCaseId: string | undefined,
  q: string,
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  // fileRef picker: route to the case-scoped Document endpoint instead of
  // Haystack /read. Requires a known case context — without scopeCaseId we
  // fall through to the legacy haystack path (which will produce an empty
  // grid for refTarget==='doc', but at least won't 500).
  if (refTarget === 'doc' && scopeCaseId) {
    return fetchDocResults(scopeCaseId, q);
  }
  const filter = composeFilter(refTarget, personMarkers, scopeFilter);
  try {
    // Route through the same-origin proxy via the typed client. The proxy
    // attaches the bearer auth server-side; the browser never sees the key.
    // haystackRead has no AbortSignal hook, but the outer effect still drops
    // stale results via ctl.signal.aborted before applying them.
    //
    // Per-target fetch cap. Courts are a small global catalogue (≈309 rows
    // seeded incl. all US state/federal trial/appellate/supreme courts), so
    // bump to 400 to keep the entire catalogue reachable by substring narrow.
    // motion/doc/motionAttachment/hearing are now case-scoped via scopeFilter
    // (Task #4), so the candidate set is bounded by case size (typically
    // <100). Lift the cap to 200 so all in-case rows fit. Person is global
    // but small in practice (judges/lawyers per case), 100 is plenty.
    const fetchLimit =
      refTarget === 'court' ? 400 :
      refTarget === 'motion' || refTarget === 'doc' ||
        refTarget === 'motionAttachment' || refTarget === 'hearing' ? 200 :
      refTarget === 'person' ? 100 :
      50;
    const grid: HaysonGrid = await haystackRead({ filter, limit: fetchLimit });
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
    // Client-side case scoping. The route synthesizes `caseRef` post-read from
    // the row's `caseId` FK column, so we filter on that here. This replaces a
    // broken server-side `caseRef==@<id>` Haystack filter — Motion/MotionAttachment
    // /Hearing tables don't store caseRef in `tags`, only on the `caseId` column,
    // and the SQL compiler only looks in tags. See haystack-filter-sql.ts.
    const scopedRows = scopeCaseId
      ? rows.filter((r) => {
          const cr = (r as { caseRef?: unknown }).caseRef;
          const id =
            typeof cr === 'string' ? cr :
            cr && typeof cr === 'object'
              ? ((cr as { val?: unknown }).val as string | undefined)
              : undefined;
          if (!id) return false;
          const canon = id.startsWith('@') ? id : `@${id}`;
          return canon === scopeCaseId;
        })
      : rows;
    const mapped = scopedRows.map((r) => labelRow(refTarget, r));
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
  scopeCaseId,
  value,
  onChange,
  onClose,
  anchorRect,
  excludeIds,
}: RefPickerProps) {
  const excludeKey = (excludeIds ?? []).join(',');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<RefResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [highlight, setHighlight] = useState(0);

  // ---- Person filter chips ------------------------------------------------
  // Active intrinsic-marker roles for Person results. AND-narrows the
  // Haystack filter. Initialized from `personMarker` for back-compat with
  // callers that haven't migrated. Only meaningful when refTarget==='person'.
  const [activeRoles, setActiveRoles] = useState<PersonMarker[]>(
    refTarget === 'person' && personMarker ? [personMarker] : [],
  );
  // Courts that have at least one Person attached (via PersonRole→Case→Court).
  // Populated on first open of a Person picker. Empty until then.
  const [courtChoices, setCourtChoices] = useState<{ id: string; name: string }[]>([]);
  // Currently selected court chip (canonical '@<id>') — narrows results to
  // persons attached to that court. null = no court filter.
  const [activeCourtId, setActiveCourtId] = useState<string | null>(null);
  // PersonIds attached to `activeCourtId`. Used to intersect with Haystack
  // person results client-side, since the Haystack filter only sees
  // `json_extract(tags,'$.X')` on the Person row — not joined PersonRole.
  const [courtPersonIds, setCourtPersonIds] = useState<Set<string> | null>(null);

  const toggleRole = useCallback((m: PersonMarker) => {
    setActiveRoles((cur) =>
      cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m],
    );
  }, []);
  const toggleCourt = useCallback((id: string) => {
    setActiveCourtId((cur) => (cur === id ? null : id));
  }, []);

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

  const rolesKey = [...activeRoles].sort().join('+');

  // Fetch on debounced query / role / court change.
  useEffect(() => {
    const key = cacheKey(
      refTarget,
      activeRoles,
      scopeFilter,
      scopeCaseId,
      activeCourtId ?? undefined,
      debounced,
    );
    const cached = cacheGet(key);
    if (cached) {
      setResults(cached);
      setHighlight(0);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    fetchResults(refTarget, activeRoles, scopeFilter, scopeCaseId, debounced, ctl.signal)
      .then((out) => {
        if (ctl.signal.aborted) return;
        setUnauthorized(out.unauthorized);
        const excludeSet = new Set(excludeIds ?? []);
        let filtered = excludeSet.size > 0
          ? out.results.filter((r) => !excludeSet.has(r.id))
          : out.results;
        // Court intersect — only for person picker with an active court chip.
        if (refTarget === 'person' && activeCourtId && courtPersonIds) {
          filtered = filtered.filter((r) => courtPersonIds.has(r.id));
        }
        setResults(filtered);
        setHighlight(0);
        // Cache the unfiltered set so a sibling picker without the same
        // exclusion still benefits.
        if (!out.unauthorized) cachePut(key, out.results);
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
    // rolesKey + activeCourtId + courtPersonIds are intentional triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refTarget, rolesKey, scopeFilter, scopeCaseId, debounced, excludeKey, excludeIds, activeCourtId, courtPersonIds]);

  // Load court choices once for person pickers.
  useEffect(() => {
    if (refTarget !== 'person') return;
    let aborted = false;
    fetch('/api/people/courts')
      .then((r) => (r.ok ? r.json() : { courts: [] }))
      .then((j: { courts?: { id: string; name: string }[] }) => {
        if (aborted) return;
        setCourtChoices(Array.isArray(j.courts) ? j.courts : []);
      })
      .catch(() => {
        if (!aborted) setCourtChoices([]);
      });
    return () => {
      aborted = true;
    };
  }, [refTarget]);

  // Load person ids for selected court (or clear when none).
  useEffect(() => {
    if (refTarget !== 'person' || !activeCourtId) {
      setCourtPersonIds(null);
      return;
    }
    let aborted = false;
    fetch(`/api/people/courts?courtId=${encodeURIComponent(activeCourtId)}`)
      .then((r) => (r.ok ? r.json() : { personIds: [] }))
      .then((j: { personIds?: string[] }) => {
        if (aborted) return;
        setCourtPersonIds(new Set(Array.isArray(j.personIds) ? j.personIds : []));
      })
      .catch(() => {
        if (!aborted) setCourtPersonIds(new Set());
      });
    return () => {
      aborted = true;
    };
  }, [refTarget, activeCourtId]);

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
    : refTarget === 'doc'
      ? 'Search files by name or filing…'
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

      {/* Person role + court filter chips */}
      {refTarget === 'person' && (
        <div className="px-2 py-1.5 border-b border-gray-100 bg-white space-y-1">
          <div className="flex flex-wrap gap-1">
            {PERSON_ROLE_CHIPS.map((c) => {
              const on = activeRoles.includes(c.marker);
              return (
                <button
                  key={c.marker}
                  type="button"
                  onClick={() => toggleRole(c.marker)}
                  className={
                    'px-1.5 py-0.5 rounded text-[11px] border transition-colors ' +
                    (on
                      ? 'bg-blue-100 text-blue-800 border-blue-300'
                      : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100')
                  }
                  aria-pressed={on}
                  title={`Filter by ${c.label}`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          {courtChoices.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {courtChoices.map((co) => {
                const on = activeCourtId === co.id;
                return (
                  <button
                    key={co.id}
                    type="button"
                    onClick={() => toggleCourt(co.id)}
                    className={
                      'px-1.5 py-0.5 rounded text-[10px] border transition-colors max-w-[200px] truncate ' +
                      (on
                        ? 'bg-blue-100 text-blue-800 border-blue-300'
                        : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100')
                    }
                    aria-pressed={on}
                    title={`Filter to people at ${co.name}`}
                  >
                    {co.name}
                  </button>
                );
              })}
            </div>
          )}
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
            {debounced
              ? 'No matches.'
              : refTarget === 'doc'
                ? 'No documents in this case.'
                : 'Start typing to search.'}
          </div>
        ) : (
          <ul className="py-1">
            {results.map((r, i) => {
              const isSelected = chips.includes(r.id);
              return (
              <li key={r.id + i}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => select(r.id)}
                  className={`w-full text-left px-2 py-1 flex flex-col gap-0.5 ${
                    i === highlight ? 'bg-blue-50' : isSelected ? 'bg-emerald-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="flex items-center gap-1 min-w-0">
                    {isSelected && (
                      <span
                        className="text-[10px] text-emerald-700 shrink-0"
                        aria-label="currently selected"
                        title="Currently selected"
                      >
                        ✓
                      </span>
                    )}
                    <span className="text-[12px] text-gray-900 truncate">{r.primary}</span>
                    {r.badges && r.badges.length > 0 && (
                      <span className="flex flex-wrap gap-1 shrink-0">
                        {r.badges.map((b) => (
                          <span
                            key={b}
                            className="text-[9px] px-1 py-0 rounded bg-blue-50 text-blue-700 border border-blue-200"
                          >
                            {b}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  {r.secondary && (
                    <span className="text-[10px] text-gray-500 truncate">{r.secondary}</span>
                  )}
                  {r.tertiary && (
                    <span className="text-[10px] text-gray-400 truncate">{r.tertiary}</span>
                  )}
                  <span className="text-[10px] text-gray-300 truncate">{r.id}</span>
                </button>
              </li>
              );
            })}
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
