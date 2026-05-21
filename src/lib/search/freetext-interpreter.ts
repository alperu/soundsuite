/**
 * Freetext → Haystack interpreter.
 *
 * Turns natural-language search input like "motions Judge Roberts signed last
 * week" into structured chips + a compiled Haystack filter so the search bar
 * "just works" in Haystack-default mode. See docs/xeto-haystack-research.md
 * §5 + §11 for filter syntax.
 *
 * Design notes:
 *  - `compiledFilter` is the source of truth fed to the Haystack `read` op.
 *    `chips` is a best-effort projection for the UI's roundtrip — concepts that
 *    do not fit `TOKEN_MAP` (jurisdiction markers, revisionSeq > 1, bare entity
 *    markers) are only ever expressed in `compiledFilter`.
 *  - Three-stage cascade: Stage A pattern extraction (deterministic), Stage B
 *    heuristic completion, Stage C LLM fallback (scaffold only).
 */

// Inline minimal date helpers — `date-fns` is not a project dependency.
function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

import {
  FilterChip,
  TOKEN_MAP,
  buildHaystackFilter,
} from './haystack-query-builder';

// Spec uses the name "HaystackChip"; the codebase uses "FilterChip". Alias so
// both work.
export type HaystackChip = FilterChip;

// ---------- public types ---------------------------------------------------

export interface PersonIndexEntry {
  id: string;
  displayName: string;
  /** Intrinsic xeto markers, e.g. { judge: true, lawyer: false }. */
  intrinsicTags: Record<string, boolean>;
}

export interface CaseIndexEntry {
  id: string;
  causeNo?: string;
  name?: string;
}

export interface InterpretContext {
  personIndex: PersonIndexEntry[];
  caseIndex: CaseIndexEntry[];
  now: Date;
}

export interface InterpretResult {
  chips: HaystackChip[];
  freetextResidual: string;
  compiledFilter: string;
  confidence: 'high' | 'medium' | 'low';
  debug?: { stages: string[]; notes: string[] };
}

// ---------- helpers --------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'by', 'for', 'with', 'and', 'or', 'to',
  'from', 'at', 'all', 'any', 'case', 'cases', 'show', 'me', 'find', 'list',
  'that', 'which', 'who', 'whom', 'has', 'have', 'been', 'was', 'were', 'is',
  'are', 'as', 'so', 'than', 'about',
]);

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (a.length > b.length) [a, b] = [b, a];
  let prev = new Array(a.length + 1);
  let curr = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(curr[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length];
}

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s.\-']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfWeek(d: Date): Date {
  // Monday-start week.
  const day = d.getDay(); // 0 sun .. 6 sat
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), diff);
}

// ---------- date parsing ---------------------------------------------------

interface DateMatch {
  span: [number, number];
  /** Either a single date or a date range. */
  iso?: string;
  range?: { start: string; end: string };
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function tryParseExplicitDate(text: string, now: Date): string | null {
  const trimmed = text.trim().replace(/\./g, '').replace(/,/g, '');
  // ISO yyyy-mm-dd
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (validYmd(y, mo, d)) return isoDate(new Date(y, mo - 1, d));
  }
  // M/D/YYYY or M/D/YY
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const mo = +m[1], d = +m[2];
    if (validYmd(y, mo, d)) return isoDate(new Date(y, mo - 1, d));
  }
  // Month name + day + optional year
  m = /^([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/.exec(trimmed);
  if (m) {
    const mo = MONTH_NAMES[m[1].toLowerCase()];
    if (mo) {
      const d = +m[2];
      const y = m[3] ? +m[3] : now.getFullYear();
      if (validYmd(y, mo, d)) return isoDate(new Date(y, mo - 1, d));
    }
  }
  return null;
}

function extractDates(input: string, now: Date): {
  matches: DateMatch[];
  residual: string;
} {
  const matches: DateMatch[] = [];
  let residual = input;

  type Rule = {
    re: RegExp;
    handle: (m: RegExpExecArray) => DateMatch | null;
  };

  const ymd = (d: Date) => isoDate(d);

  const rules: Rule[] = [
    {
      re: /\btoday\b/i,
      handle: (m) => ({ span: [m.index, m.index + m[0].length], iso: ymd(now) }),
    },
    {
      re: /\byesterday\b/i,
      handle: (m) => ({ span: [m.index, m.index + m[0].length], iso: ymd(addDays(now, -1)) }),
    },
    {
      re: /\btomorrow\b/i,
      handle: (m) => ({ span: [m.index, m.index + m[0].length], iso: ymd(addDays(now, 1)) }),
    },
    {
      re: /\b(last|this|next)\s+week\b/i,
      handle: (m) => {
        const which = m[1].toLowerCase();
        const thisWeekStart = startOfWeek(now);
        const start =
          which === 'last' ? addDays(thisWeekStart, -7) :
          which === 'next' ? addDays(thisWeekStart, 7) :
          thisWeekStart;
        const end = addDays(start, 6);
        return { span: [m.index, m.index + m[0].length], range: { start: ymd(start), end: ymd(end) } };
      },
    },
    // between X and Y
    {
      re: /\bbetween\s+([A-Za-z0-9,\/\s\-]+?)\s+and\s+([A-Za-z0-9,\/\s\-]+?)(?=$|[,\.;]|\s(?:by|in|on|for|with|filed|signed|the|a)\b)/i,
      handle: (m) => {
        const a = tryParseExplicitDate(m[1], now);
        const b = tryParseExplicitDate(m[2], now);
        if (!a || !b) return null;
        return { span: [m.index, m.index + m[0].length], range: { start: a, end: b } };
      },
    },
    // after X / before X
    {
      re: /\b(after|since)\s+([A-Za-z0-9,\/\-\s]+?)(?=$|[,\.;]|\s(?:by|in|on|for|with|filed|signed)\b)/i,
      handle: (m) => {
        const d = tryParseExplicitDate(m[2], now);
        if (!d) return null;
        return { span: [m.index, m.index + m[0].length], range: { start: d, end: '9999-12-31' } };
      },
    },
    {
      re: /\bbefore\s+([A-Za-z0-9,\/\-\s]+?)(?=$|[,\.;]|\s(?:by|in|on|for|with|filed|signed)\b)/i,
      handle: (m) => {
        const d = tryParseExplicitDate(m[1], now);
        if (!d) return null;
        return { span: [m.index, m.index + m[0].length], range: { start: '0001-01-01', end: d } };
      },
    },
    // ISO yyyy-mm-dd
    {
      re: /\b(\d{4}-\d{2}-\d{2})\b/,
      handle: (m) => {
        const d = tryParseExplicitDate(m[1], now);
        if (!d) return null;
        return { span: [m.index, m.index + m[0].length], iso: d };
      },
    },
    // M/D/YYYY or M/D/YY
    {
      re: /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/,
      handle: (m) => {
        const d = tryParseExplicitDate(m[1], now);
        if (!d) return null;
        return { span: [m.index, m.index + m[0].length], iso: d };
      },
    },
    // Month name + day [+ year]
    {
      re: /\b((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(?:,?\s+\d{4})?)\b/i,
      handle: (m) => {
        const d = tryParseExplicitDate(m[1].replace(/\./g, ''), now);
        if (!d) return null;
        return { span: [m.index, m.index + m[0].length], iso: d };
      },
    },
  ];

  // Run rules in order, masking out matched spans as we go.
  const mask: boolean[] = new Array(residual.length).fill(false);
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(residual)) !== null) {
      // Skip if span overlaps mask.
      const [s, e] = [m.index, m.index + m[0].length];
      if (mask.slice(s, e).some(Boolean)) continue;
      const out = rule.handle(m);
      if (!out) continue;
      for (let i = s; i < e; i++) mask[i] = true;
      matches.push(out);
    }
  }

  // Build residual by removing masked spans.
  let result = '';
  for (let i = 0; i < residual.length; i++) {
    if (!mask[i]) result += residual[i];
  }
  return { matches, residual: result };
}

// ---------- person resolution ---------------------------------------------

interface PersonMatch {
  entry: PersonIndexEntry;
  /** 1.0 exact, 0.85 levenshtein, 0.6 token-set. */
  score: number;
  span: [number, number];
  /** Context word immediately before, e.g. "judge", "by", "movant". */
  precededBy?: string;
  /** Honorific captured ("judge", "hon", "atty", etc.). */
  honorific?: string;
  ambiguous: boolean;
}

const PERSON_HONORIFIC_RE =
  /\b(?:(judge|hon\.?|honorable|atty\.?|attorney|mr\.?|ms\.?|mrs\.?|dr\.?)\s+)?([A-Z][A-Za-z.\-']{1,}(?:\s+[A-Z][A-Za-z.\-']{1,}){0,2})\b/g;

function findPersonMatches(text: string, index: PersonIndexEntry[]): PersonMatch[] {
  if (!index.length) return [];
  const matches: PersonMatch[] = [];
  // Pre-tokenized name forms for fuzzy.
  const indexed = index.map((p) => ({
    p,
    lower: p.displayName.toLowerCase(),
    tokens: new Set(tokenize(p.displayName)),
    lastName: tokenize(p.displayName).slice(-1)[0] ?? '',
  }));

  let m: RegExpExecArray | null;
  const re = new RegExp(PERSON_HONORIFIC_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const honorific = m[1]?.toLowerCase().replace(/\.$/, '');
    const candidate = m[2];
    if (!candidate) continue;
    const candLower = candidate.toLowerCase();
    const candTokens = new Set(tokenize(candidate));
    const candLast = tokenize(candidate).slice(-1)[0] ?? '';

    // Skip if candidate is itself a stop-word entity noun.
    const entityNouns = new Set([
      'motion', 'motions', 'hearing', 'hearings', 'order', 'orders',
      'brief', 'briefs', 'response', 'responses', 'exhibit', 'exhibits',
      'lawyer', 'lawyers', 'attorney', 'attorneys', 'judge', 'judges',
      'person', 'persons', 'people', 'case', 'cases', 'amended', 'original',
      'proposed', 'reply', 'replies', 'affidavit', 'declaration',
      'texas', 'california', 'federal', 'today', 'yesterday', 'tomorrow',
      'last', 'this', 'next', 'week', 'month', 'year',
    ]);
    if (candLower.split(/\s+/).every((t) => entityNouns.has(t))) continue;

    let best: { entry: PersonIndexEntry; score: number; tied: boolean } | null = null;
    for (const idx of indexed) {
      // Exact match
      if (idx.lower === candLower) {
        best = { entry: idx.p, score: 1.0, tied: false };
        break;
      }
      // Last-name only match → strong signal if candidate is single token
      if (candTokens.size === 1 && idx.lastName && candLower === idx.lastName) {
        const sc = 0.9;
        if (!best || sc > best.score) best = { entry: idx.p, score: sc, tied: false };
        else if (best && sc === best.score) best.tied = true;
        continue;
      }
      // Levenshtein on whole name
      const dist = levenshtein(idx.lower, candLower);
      if (dist <= 2 && Math.max(idx.lower.length, candLower.length) >= 4) {
        const sc = 0.85 - dist * 0.05;
        if (!best || sc > best.score) best = { entry: idx.p, score: sc, tied: false };
        else if (best && Math.abs(sc - best.score) < 1e-6) best.tied = true;
        continue;
      }
      // Token-set jaccard
      let inter = 0;
      for (const t of candTokens) if (idx.tokens.has(t)) inter++;
      const union = candTokens.size + idx.tokens.size - inter;
      if (union > 0) {
        const j = inter / union;
        if (j >= 0.5) {
          const sc = 0.5 + j * 0.2;
          if (!best || sc > best.score) best = { entry: idx.p, score: sc, tied: false };
          else if (best && Math.abs(sc - best.score) < 1e-6) best.tied = true;
        }
      }
    }
    if (!best) continue;

    // Locate the preceding contextual word (skip the honorific that's part of m[0]).
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const prevWord = before.match(/(\w+)\s*$/i)?.[1]?.toLowerCase();

    matches.push({
      entry: best.entry,
      score: best.score,
      span: [m.index, m.index + m[0].length],
      precededBy: prevWord,
      honorific,
      ambiguous: best.tied,
    });
  }
  return matches;
}

// ---------- case resolution -----------------------------------------------

const CAUSE_NO_RE = /\b([A-Z]-?\d+-?[A-Z]+-?\d+-\d+)\b/g;

interface CaseMatch {
  entry: CaseIndexEntry;
  span: [number, number];
  score: number;
}

function findCaseMatches(text: string, index: CaseIndexEntry[]): CaseMatch[] {
  const out: CaseMatch[] = [];
  // Cause numbers first
  let m: RegExpExecArray | null;
  const re = new RegExp(CAUSE_NO_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const cn = m[1].replace(/-/g, '').toLowerCase();
    for (const c of index) {
      if (c.causeNo && c.causeNo.replace(/-/g, '').toLowerCase() === cn) {
        out.push({ entry: c, span: [m.index, m.index + m[0].length], score: 1.0 });
        break;
      }
    }
  }
  // "vs" name matches — best-effort token-set.
  const vsRe = /\b([A-Z][A-Za-z.\-']+)\s+(?:v\.?|vs\.?)\s+([A-Z][A-Za-z.\-']+)\b/g;
  let n: RegExpExecArray | null;
  while ((n = vsRe.exec(text)) !== null) {
    const tokens = new Set([n[1].toLowerCase(), n[2].toLowerCase()]);
    let best: { c: CaseIndexEntry; sc: number } | null = null;
    for (const c of index) {
      if (!c.name) continue;
      const nameTokens = new Set(tokenize(c.name));
      let inter = 0;
      for (const t of tokens) if (nameTokens.has(t)) inter++;
      const sc = inter / Math.max(tokens.size, 1);
      if (sc >= 0.5 && (!best || sc > best.sc)) best = { c, sc };
    }
    if (best) out.push({ entry: best.c, span: [n.index, n.index + n[0].length], score: best.sc });
  }
  return out;
}

// ---------- entity + marker detection -------------------------------------

interface EntityMarkers {
  /** Entity (table) marker: motion / motionEvent / motionAttachment / hearing / person / case / personRole. */
  entity?: string;
  /** Additional intrinsic marker tags AND'd into the filter (jurisdictionTx, lawyer, judge, etc.). */
  extraMarkers: string[];
  /** Spans to strip from the residual. */
  spans: Array<[number, number]>;
  /** True if user explicitly said "person", "lawyer", "judge" etc (i.e. searching the Person pool itself). */
  personPool: boolean;
}

const ENTITY_PATTERNS: Array<{ re: RegExp; entity?: string; markers?: string[]; personPool?: boolean }> = [
  { re: /\bmotion(s)?\b/gi, entity: 'motion' },
  { re: /\bhearing(s)?\b/gi, entity: 'hearing' },
  { re: /\bproposed\s+order(s)?\b/gi, entity: 'motionAttachment', markers: ['attachmentKind=="proposedOrder"'] },
  { re: /\bbrief(s)?\b/gi, entity: 'motionAttachment', markers: ['attachmentKind=="brief"'] },
  { re: /\bresponse(s)?\b/gi, entity: 'motionAttachment', markers: ['attachmentKind=="response"'] },
  { re: /\bexhibit(s)?\b/gi, entity: 'motionAttachment', markers: ['attachmentKind=="exhibit"'] },
  { re: /\breply\b|\breplies\b/gi, entity: 'motionAttachment', markers: ['attachmentKind=="reply"'] },
  { re: /\baffidavit(s)?\b/gi, entity: 'motionAttachment', markers: ['attachmentKind=="affidavit"'] },
  { re: /\bdeclaration(s)?\b/gi, entity: 'motionAttachment', markers: ['attachmentKind=="declaration"'] },
  { re: /\blawyer(s)?\b|\battorney(s)?\b/gi, entity: 'person', markers: ['lawyer'], personPool: true },
  { re: /\bjudge(s)?\b(?!\s+[A-Z])/gi, entity: 'person', markers: ['judge'], personPool: true }, // "judges" standalone, not "Judge Roberts"
  { re: /\bclerk(s)?\b/gi, entity: 'person', markers: ['courtClerk'], personPool: true },
  { re: /\breporter(s)?\b/gi, entity: 'person', markers: ['courtReporter'], personPool: true },
  { re: /\bperson(s)?\b|\bpeople\b/gi, entity: 'person', personPool: true },
];

const JURISDICTION_PATTERNS: Array<{ re: RegExp; marker: string }> = [
  { re: /\btexas\b|\btx\b/gi, marker: 'jurisdictionTx' },
  { re: /\bcalifornia\b|\bca\b/gi, marker: 'jurisdictionCa' },
  { re: /\bfederal\b|\bfed\b/gi, marker: 'jurisdictionFed' },
];

function extractEntityMarkers(text: string): EntityMarkers {
  const result: EntityMarkers = { extraMarkers: [], spans: [], personPool: false };

  for (const pat of ENTITY_PATTERNS) {
    const re = new RegExp(pat.re.source, pat.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!result.entity) result.entity = pat.entity;
      else if (pat.entity && result.entity !== pat.entity) {
        // First entity wins; ignore conflicting later ones.
      }
      if (pat.markers) result.extraMarkers.push(...pat.markers);
      if (pat.personPool) result.personPool = true;
      result.spans.push([m.index, m.index + m[0].length]);
    }
  }

  for (const j of JURISDICTION_PATTERNS) {
    const re = new RegExp(j.re.source, j.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      result.extraMarkers.push(j.marker);
      result.spans.push([m.index, m.index + m[0].length]);
    }
  }

  return result;
}

// ---------- amendment detection -------------------------------------------

function extractAmendment(text: string): { marker?: string; spans: Array<[number, number]> } {
  const patterns: Array<{ re: RegExp; marker: string }> = [
    { re: /\b(second|twice)\s+amended\b/gi, marker: 'revisionSeq==3' },
    { re: /\b(first)\s+amended\b/gi, marker: 'revisionSeq==2' },
    { re: /\boriginal\b/gi, marker: 'revisionSeq==1' },
    { re: /\bamended\b/gi, marker: 'revisionSeq>1' },
  ];
  for (const p of patterns) {
    const re = new RegExp(p.re.source, p.re.flags);
    const m = re.exec(text);
    if (m) {
      return { marker: p.marker, spans: [[m.index, m.index + m[0].length]] };
    }
  }
  return { spans: [] };
}

// ---------- verb (event kind) detection -----------------------------------

interface VerbMatch {
  kind: 'filed' | 'signed' | 'received' | 'heard' | 'granted' | 'denied' | 'served' | 'courtFiled';
  span: [number, number];
}

const VERB_PATTERNS: Array<{ re: RegExp; kind: VerbMatch['kind'] }> = [
  { re: /\bcourt[\s-]?filed\b/gi, kind: 'courtFiled' },
  { re: /\bfiled\b/gi, kind: 'filed' },
  { re: /\bsigned\b/gi, kind: 'signed' },
  { re: /\breceived\b/gi, kind: 'received' },
  { re: /\bheard\b/gi, kind: 'heard' },
  { re: /\bgranted\b/gi, kind: 'granted' },
  { re: /\bdenied\b/gi, kind: 'denied' },
  { re: /\bserved\b/gi, kind: 'served' },
];

function extractVerbs(text: string): VerbMatch[] {
  const matches: VerbMatch[] = [];
  for (const p of VERB_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({ kind: p.kind, span: [m.index, m.index + m[0].length] });
    }
  }
  return matches;
}

// ---------- role context detection ----------------------------------------

/** Detects "as movant", "as respondent", "movant X", "respondent X". */
function detectRoleContext(text: string, personSpan: [number, number]):
  | 'movant' | 'respondent' | 'judge' | 'lawyer' | undefined {
  // Look 25 chars before and 25 after for role keywords.
  const pre = text.slice(Math.max(0, personSpan[0] - 30), personSpan[0]).toLowerCase();
  const post = text.slice(personSpan[1], Math.min(text.length, personSpan[1] + 30)).toLowerCase();
  if (/\bmovant\b/.test(pre) || /\bas\s+movant\b/.test(post) || /\bmovant\b/.test(post)) return 'movant';
  if (/\brespondent\b/.test(pre) || /\bas\s+respondent\b/.test(post) || /\brespondent\b/.test(post)) return 'respondent';
  if (/\bjudge\b/.test(pre) || /\bhon\.?\b/.test(pre) || /\bhonorable\b/.test(pre)) return 'judge';
  if (/\batty\.?\b/.test(pre) || /\battorney\b/.test(pre)) return 'lawyer';
  return undefined;
}

// ---------- main interpreter ----------------------------------------------

/** Strip spans from text, return remaining + a debug-cleanable string. */
function stripSpans(text: string, spans: Array<[number, number]>): string {
  if (!spans.length) return text;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [s, e] of sorted) {
    if (s >= cursor) {
      out += text.slice(cursor, s);
      cursor = e;
    } else if (e > cursor) {
      cursor = e;
    }
  }
  out += text.slice(cursor);
  return out.replace(/\s+/g, ' ').trim();
}

function cleanResidual(s: string): string {
  const tokens = s.split(/\s+/).filter(Boolean);
  // If 3 or fewer words and all stop-words → drop entirely.
  if (tokens.length <= 3 && tokens.every((t) => STOP_WORDS.has(t.toLowerCase()))) return '';
  return tokens.join(' ').trim();
}

export async function interpretQuery(
  text: string,
  ctx: InterpretContext,
): Promise<InterpretResult> {
  const stages: string[] = [];
  const notes: string[] = [];
  const input = text.trim();

  if (!input) {
    return {
      chips: [],
      freetextResidual: '',
      compiledFilter: '',
      confidence: 'low',
      debug: { stages: ['empty'], notes: [] },
    };
  }

  // ---------- Stage A: pattern extraction ----------
  stages.push('stageA:dates');
  const { matches: dateMatches, residual: afterDates } = extractDates(input, ctx.now);

  stages.push('stageA:entity');
  const entityInfo = extractEntityMarkers(input);

  stages.push('stageA:amendment');
  const amend = extractAmendment(input);

  stages.push('stageA:verbs');
  const verbs = extractVerbs(input);

  stages.push('stageA:cases');
  const caseMatches = findCaseMatches(input, ctx.caseIndex);

  stages.push('stageA:persons');
  const personMatches = findPersonMatches(input, ctx.personIndex);

  // Filter out person matches that overlap entity/jurisdiction/date/verb spans.
  const allConsumed: Array<[number, number]> = [
    ...entityInfo.spans,
    ...amend.spans,
    ...caseMatches.map((c) => c.span),
    ...verbs.map((v) => v.span),
  ];
  const overlaps = (a: [number, number], list: Array<[number, number]>) =>
    list.some(([s, e]) => !(a[1] <= s || a[0] >= e));
  const filteredPersons = personMatches.filter((pm) => !overlaps(pm.span, allConsumed));

  // ---------- Build the compiled filter pieces ----------
  const chips: HaystackChip[] = [];
  const filterTerms: string[] = [];
  const consumedSpans: Array<[number, number]> = [...entityInfo.spans, ...amend.spans];
  let anyAmbiguous = false;

  // Decide entity / record kind.
  let entity = entityInfo.entity;
  // If we have a verb but no entity, default to motionEvent (signed/filed/etc are events).
  // If we have a hearing verb ("heard"), prefer hearing entity.
  if (!entity && verbs.length) {
    if (verbs.some((v) => v.kind === 'heard')) entity = 'hearing';
    else entity = 'motionEvent';
    notes.push(`stageB: defaulted entity to ${entity} from verb`);
  }
  // If we have a date but no entity, default to motionEvent (for filing dates).
  if (!entity && dateMatches.length) {
    entity = 'motionEvent';
    notes.push('stageB: defaulted entity to motionEvent from date');
  }
  // If we only have persons + no entity, default to motion.
  if (!entity && filteredPersons.length) {
    entity = 'motion';
    notes.push('stageB: defaulted entity to motion from person');
  }
  // If we have a case ref but no entity, default to motion (most common).
  if (!entity && caseMatches.length) {
    entity = 'motion';
    notes.push('stageB: defaulted entity to motion from case');
  }

  if (entity) filterTerms.push(entity);

  // Extra markers (jurisdiction, person-pool markers, attachment kind).
  for (const m of entityInfo.extraMarkers) {
    filterTerms.push(m);
  }

  // Amendment marker.
  if (amend.marker) filterTerms.push(amend.marker);

  // Verbs (kind chips). For motionEvent, attach kind=="<verb>". Skip if entity is hearing.
  if (verbs.length && entity === 'motionEvent') {
    // Prefer signed > filed > others, but if user said multiple, take the first.
    const v = verbs[0];
    filterTerms.push(`kind=="${v.kind}"`);
    chips.push({ key: 'kind', value: v.kind });
    consumedSpans.push(v.span);
  } else if (verbs.length && entity === 'hearing') {
    consumedSpans.push(...verbs.map((v) => v.span));
  } else if (verbs.length) {
    // We have a verb but a non-event entity (e.g. motion + "signed"). Promote
    // the verb to a motionEvent kind constraint but keep the user's entity by
    // switching to motionEvent — that's the source of truth.
    const v = verbs[0];
    if (entity === 'motion') {
      // Replace the leading 'motion' with 'motionEvent' since kind belongs to events.
      filterTerms[0] = 'motionEvent';
      filterTerms.push(`kind=="${v.kind}"`);
      chips.push({ key: 'kind', value: v.kind });
      consumedSpans.push(v.span);
      notes.push('stageB: promoted motion → motionEvent because of verb');
    } else {
      consumedSpans.push(v.span);
    }
  }

  // Dates — emit date filter terms.
  for (const d of dateMatches) {
    // Pick a tag based on context:
    //  - hearing entity → scheduledFor
    //  - heard verb → scheduledFor
    //  - filed/courtFiled verb → courtFilingDate
    //  - signed verb → occurredOn
    //  - default → courtFilingDate (on motionEvent) or hearingDate (on hearing) or signedDate fallback
    let tag: string;
    if (entity === 'hearing' || verbs.some((v) => v.kind === 'heard')) tag = 'scheduledFor';
    else if (verbs.some((v) => v.kind === 'signed')) tag = 'occurredOn';
    else tag = 'courtFilingDate';

    if (d.iso) {
      filterTerms.push(`${tag}=="${d.iso}"`);
      // Chip projection for known keys
      if (tag === 'courtFilingDate') {
        chips.push({ key: 'filedAfter', value: d.iso });
        chips.push({ key: 'filedBefore', value: d.iso });
      }
    } else if (d.range) {
      filterTerms.push(`${tag}>=${d.range.start} and ${tag}<=${d.range.end}`);
      if (tag === 'courtFilingDate') {
        chips.push({ key: 'filedAfter', value: d.range.start });
        chips.push({ key: 'filedBefore', value: d.range.end });
      }
    }
  }

  // Case refs.
  for (const c of caseMatches) {
    filterTerms.push(`caseRef==@${c.entry.id}`);
    chips.push({ key: 'case', value: `@${c.entry.id}`, label: c.entry.causeNo ?? c.entry.name });
  }

  // Persons — role inference.
  for (const pm of filteredPersons) {
    if (pm.ambiguous) anyAmbiguous = true;
    const role = detectRoleContext(input, pm.span);
    const isJudge = pm.entry.intrinsicTags?.judge === true;
    const isLawyer = pm.entry.intrinsicTags?.lawyer === true;

    let chosenRole: 'judge' | 'movant' | 'respondent' | 'lawyer' | 'author' = 'lawyer';
    if (role === 'judge' || isJudge) chosenRole = 'judge';
    else if (role === 'movant') chosenRole = 'movant';
    else if (role === 'respondent') chosenRole = 'respondent';
    else if (verbs.some((v) => v.kind === 'filed') && pm.precededBy === 'by') chosenRole = 'author';
    else if (verbs.some((v) => v.kind === 'signed') && isJudge) chosenRole = 'judge';
    else if (isLawyer) chosenRole = 'lawyer';

    // If the entity is personRole or the input had "as movant/respondent" → emit a PersonRole filter.
    if (role === 'movant' || role === 'respondent') {
      // Switch entity to personRole if we don't already have one and the user
      // is asking "everyone X has appeared as movant for".
      if (!entityInfo.entity) {
        filterTerms[0] = 'personRole';
        entity = 'personRole';
      }
      filterTerms.push(chosenRole); // marker tag
      filterTerms.push(`personRef==@${pm.entry.id}`);
      chips.push({ key: chosenRole, value: `@${pm.entry.id}`, label: pm.entry.displayName });
      consumedSpans.push(pm.span);
      continue;
    }

    if (chosenRole === 'judge') {
      filterTerms.push(`judgeRef==@${pm.entry.id}`);
      chips.push({ key: 'judge', value: `@${pm.entry.id}`, label: pm.entry.displayName });
    } else if (chosenRole === 'lawyer') {
      filterTerms.push(`lawyerRef==@${pm.entry.id}`);
      chips.push({ key: 'lawyer', value: `@${pm.entry.id}`, label: pm.entry.displayName });
    } else if (chosenRole === 'movant') {
      filterTerms.push(`movantRef==@${pm.entry.id}`);
      chips.push({ key: 'movant', value: `@${pm.entry.id}`, label: pm.entry.displayName });
    } else if (chosenRole === 'respondent') {
      filterTerms.push(`respondentRef==@${pm.entry.id}`);
      chips.push({ key: 'respondent', value: `@${pm.entry.id}`, label: pm.entry.displayName });
    } else if (chosenRole === 'author') {
      filterTerms.push(`authoredBy==@${pm.entry.id}`);
    }
    consumedSpans.push(pm.span);
  }

  // ---------- Residual ----------
  const residual = cleanResidual(stripSpans(input, consumedSpans));

  // ---------- Final compile ----------
  // Validate: ensure the very first term is an entity marker; tableFromFilter
  // needs that. If no entity at all, the filter is empty.
  let compiledFilter = '';
  if (filterTerms.length > 0 && entity) {
    compiledFilter = filterTerms.join(' and ');
  }

  // ---------- Confidence ----------
  let confidence: InterpretResult['confidence'];
  if (!compiledFilter) confidence = 'low';
  else if (anyAmbiguous) confidence = 'medium';
  else if (filterTerms.length >= 2) confidence = 'high';
  else confidence = 'medium';

  return {
    chips,
    freetextResidual: residual,
    compiledFilter,
    confidence,
    debug: { stages, notes },
  };
}

// ---------- compileToEnglish ----------------------------------------------

/**
 * Plain-English summary for the chip set + residual. Approximate — designed
 * to be readable, not grammatically perfect.
 */
export function compileToEnglish(chips: HaystackChip[], freetext?: string): string {
  if (!chips.length && !freetext) return '';

  // Derive the implied kind (best effort).
  const result = buildHaystackFilter(chips);
  const kind = result.impliedKind ?? 'records';

  // Plural-ish wording.
  const headNoun =
    kind === 'motion' ? 'motions' :
    kind === 'motionEvent' ? 'events' :
    kind === 'motionAttachment' ? 'attachments' :
    kind === 'hearing' ? 'hearings' :
    kind === 'person' ? 'people' :
    kind === 'case' ? 'cases' :
    'records';

  const parts: string[] = [];

  // Map chips to phrases.
  const phrases: string[] = [];
  for (const c of chips) {
    const label = c.label ?? c.value;
    switch (c.key) {
      case 'judge':
        phrases.push(`signed by Judge ${stripAt(label)}`);
        break;
      case 'lawyer':
        phrases.push(`with attorney ${stripAt(label)}`);
        break;
      case 'movant':
        phrases.push(`as movant ${stripAt(label)}`);
        break;
      case 'respondent':
        phrases.push(`as respondent ${stripAt(label)}`);
        break;
      case 'case':
        phrases.push(`in case ${stripAt(label)}`);
        break;
      case 'hearingDate':
        phrases.push(`heard ${label}`);
        break;
      case 'filedAfter':
        phrases.push(`filed on or after ${label}`);
        break;
      case 'filedBefore':
        phrases.push(`filed on or before ${label}`);
        break;
      case 'dueBefore':
        phrases.push(`due before ${label}`);
        break;
      case 'dueAfter':
        phrases.push(`due after ${label}`);
        break;
      case 'motionType':
        phrases.push(`of type "${label}"`);
        break;
      case 'kind':
        phrases.push(label);
        break;
      case 'attachmentKind':
        phrases.push(`of kind "${label}"`);
        break;
      case 'revisionSeq':
        phrases.push(`revision ${label}`);
        break;
    }
  }

  parts.push(headNoun);
  if (phrases.length) parts.push(phrases.join(' '));
  if (freetext) parts.push(`matching "${freetext}"`);
  return parts.join(' ').trim();
}

function stripAt(s: string): string {
  return s.startsWith('@') ? s.slice(1) : s;
}

// ---------- LLM fallback (scaffold) ---------------------------------------

/**
 * Future: route ambiguous freetext to a local LLM running on the sidecar.
 *
 * Expected prompt shape (for a future implementer):
 *   System: "You translate legal-search freetext into a JSON object with
 *            keys {entity, filterTerms[], chips[], residual}. The entity
 *            must be one of motion|motionEvent|motionAttachment|hearing|
 *            person|personRole|case. filterTerms are bare Haystack filter
 *            fragments AND'd together. chips follow TOKEN_MAP from
 *            haystack-query-builder.ts."
 *   User: "<text>"
 *
 * Response is validated, then merged with deterministic Stage A/B output.
 * For v1 this throws — Stage A/B handle every spec test case.
 */
export async function tryLlmInterpret(
  _text: string,
  _ctx: InterpretContext,
): Promise<InterpretResult> {
  throw new Error('not_implemented: configure SIDECAR_INFERENCE_URL');
}
