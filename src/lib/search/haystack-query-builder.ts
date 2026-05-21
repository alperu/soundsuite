/**
 * Haystack filter query builder.
 *
 * Compiles an array of structured "chips" produced by the search UI
 * (HaystackFilterInput) into a Haystack v4 filter string suitable for
 * `GET /api/haystack/read?filter=...`.
 *
 * See docs/xeto-haystack-research.md §5 (Person-pool query patterns) and
 * §11 (read op + read filter examples) for the target syntax.
 *
 * Examples produced:
 *   motion and judgeRef==@person-roberts and motionType=="disqualify"
 *   motion and hearingDate>=2026-06-01 and hearingDate<=2026-06-30
 *   motionEvent and kind=="filed"
 */

/** Categories used for chip styling + compiler routing. */
export type ChipCategory = 'ref' | 'date' | 'enum' | 'number' | 'text';

/**
 * A single token chip emitted by the structured input.
 *
 * `key` is the surface token typed by the user (e.g. `judge`, `hearingDate`,
 * `motionType`). It maps to one or more Haystack filter terms via the
 * TOKEN_MAP below.
 *
 * `value` is the picked / typed value. For refs this is a `@…` id, for enums
 * a bare symbol, for dates an ISO `YYYY-MM-DD` string. For ranges, callers
 * use two chips (`filedAfter` + `filedBefore`) or a single chip whose value
 * is `YYYY-MM-DD..YYYY-MM-DD`.
 */
export interface FilterChip {
  key: string;
  value: string;
  /** Optional display label for the picked value (e.g. "Judge Roberts"). */
  label?: string;
}

/**
 * Definition of how a surface token compiles to Haystack.
 *
 * `tags` are intrinsic marker tags that, when ANY chip of this category is
 * present, get OR'd into the leading record-kind clause. e.g. a `judge:` or
 * `lawyer:` chip implies `motion` (we're filtering motions by a person ref),
 * and a `kind:` chip implies `motionEvent`. Multiple chips with conflicting
 * implied tags fall back to no implied kind — caller is free.
 */
interface TokenDef {
  /** The Haystack record-tag this chip implies (e.g. `motion`, `motionEvent`). */
  impliedKind?: string;
  /** Haystack tag name on the record (e.g. `judgeRef`, `hearingDate`). */
  tag: string;
  /** How the value should be rendered. */
  category: ChipCategory;
  /** Operator. Defaults to `==`. Date range chips override. */
  op?: '==' | '>=' | '<=' | '>' | '<';
  /** If true, value is wrapped in quotes (`"foo"`). For enums + strings. */
  quote?: boolean;
}

/**
 * Surface-token → Haystack term mapping.
 *
 * Tokens are matched case-insensitively by the picker, but the canonical key
 * stored in chips is the camelCase form below.
 */
export const TOKEN_MAP: Record<string, TokenDef> = {
  // Refs (Person pool)
  case: { tag: 'caseRef', category: 'ref' },
  judge: { impliedKind: 'motion', tag: 'judgeRef', category: 'ref' },
  lawyer: { impliedKind: 'motion', tag: 'lawyerRef', category: 'ref' },
  movant: { impliedKind: 'motion', tag: 'movantRef', category: 'ref' },
  respondent: { impliedKind: 'motion', tag: 'respondentRef', category: 'ref' },
  clerk: { impliedKind: 'motionEvent', tag: 'clerkRef', category: 'ref' },
  reporter: { impliedKind: 'motionEvent', tag: 'reporterRef', category: 'ref' },

  // Dates
  hearingDate: { impliedKind: 'motion', tag: 'hearingDate', category: 'date' },
  filedAfter: { impliedKind: 'motionEvent', tag: 'courtFilingDate', category: 'date', op: '>=' },
  filedBefore: { impliedKind: 'motionEvent', tag: 'courtFilingDate', category: 'date', op: '<=' },
  dueBefore: { impliedKind: 'motion', tag: 'dueBy', category: 'date', op: '<=' },
  dueAfter: { impliedKind: 'motion', tag: 'dueBy', category: 'date', op: '>=' },

  // Enums
  motionType: { impliedKind: 'motion', tag: 'motionType', category: 'enum', quote: true },
  kind: { impliedKind: 'motionEvent', tag: 'kind', category: 'enum', quote: true },
  attachmentKind: { impliedKind: 'motionAttachment', tag: 'attachmentKind', category: 'enum', quote: true },

  // Numbers
  revisionSeq: { tag: 'revisionSeq', category: 'number' },
};

/** Token keys, ordered for picker display. */
export const TOKEN_KEYS = Object.keys(TOKEN_MAP);

/** Enum value catalogue surfaced by the picker. Mirrors xeto specs (§5). */
export const ENUM_VALUES: Record<string, string[]> = {
  motionType: [
    'disqualify',
    'vacate',
    'compel',
    'summaryJudgment',
    'continuance',
    'reconsideration',
    'protectiveOrder',
    'sanctions',
  ],
  kind: [
    'received',
    'filed',
    'courtFiled',
    'responded',
    'signed',
    'granted',
    'denied',
    'served',
    'hearingHeld',
  ],
  attachmentKind: [
    'proposedOrder',
    'brief',
    'response',
    'reply',
    'exhibit',
    'affidavit',
    'declaration',
  ],
};

/** Person picker tag-filter for a given token. Returned for caller convenience. */
export function personFilterForToken(key: string): string | null {
  switch (key) {
    case 'judge':
      return 'person and judge';
    case 'lawyer':
      return 'person and lawyer';
    case 'clerk':
      return 'person and courtClerk';
    case 'reporter':
      return 'person and courtReporter';
    case 'movant':
    case 'respondent':
      return 'person';
    default:
      return null;
  }
}

/** Quote a haystack string literal. */
function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** Format a chip into a single Haystack filter term (without leading `and`). */
function termFor(chip: FilterChip): string | null {
  const def = TOKEN_MAP[chip.key];
  if (!def) return null;
  const op = def.op ?? '==';
  const v = chip.value.trim();
  if (!v) return null;

  switch (def.category) {
    case 'ref': {
      // Always render as `@id`. Strip a leading `@` if the caller already added one.
      const id = v.startsWith('@') ? v : `@${v}`;
      return `${def.tag}${op}${id}`;
    }
    case 'date': {
      // Date range syntax `YYYY-MM-DD..YYYY-MM-DD` → two terms ANDed.
      const m = v.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        return `${def.tag}>=${m[1]} and ${def.tag}<=${m[2]}`;
      }
      return `${def.tag}${op}${v}`;
    }
    case 'enum':
      return `${def.tag}${op}${def.quote ? quote(v) : v}`;
    case 'number':
      return `${def.tag}${op}${v}`;
    case 'text':
      return `${def.tag}${op}${quote(v)}`;
    default:
      return null;
  }
}

/**
 * Group chips by key so multiple values of the same token AND together with
 * parentheses (the spec calls for AND, not OR — multiple `movant:` chips means
 * "all of these are movants on the same record"; the UI can add a future OR
 * affordance later).
 */
function groupByKey(chips: FilterChip[]): Map<string, FilterChip[]> {
  const m = new Map<string, FilterChip[]>();
  for (const c of chips) {
    const arr = m.get(c.key) ?? [];
    arr.push(c);
    m.set(c.key, arr);
  }
  return m;
}

export interface BuildResult {
  /** Compiled Haystack filter string; empty when there are no chips. */
  filter: string;
  /** Residual freetext for the semantic pipeline. */
  freetext: string;
  /** Implied record-kind tag, if all chips agree on one. */
  impliedKind?: string;
}

/**
 * Compile chips + freetext into a Haystack filter string.
 *
 * Algorithm:
 *  1. Determine the implied record kind. If every chip's `impliedKind` matches
 *     a single value, use it. Otherwise no implied kind (caller's filter is
 *     whatever the chip tags say).
 *  2. For each key with N>1 chips, wrap in parentheses and AND the terms.
 *  3. Prepend the implied kind, AND everything together.
 */
export function buildHaystackFilter(
  chips: FilterChip[],
  freetext: string = '',
): BuildResult {
  const trimmedFree = freetext.trim();
  if (chips.length === 0) {
    return { filter: '', freetext: trimmedFree };
  }

  // Step 1: implied kind. Take the most-specific (last set) kind, but if any
  // chip has a different impliedKind, drop the implication entirely.
  let impliedKind: string | undefined;
  let kindConflict = false;
  for (const c of chips) {
    const def = TOKEN_MAP[c.key];
    if (!def?.impliedKind) continue;
    if (impliedKind && impliedKind !== def.impliedKind) {
      kindConflict = true;
      break;
    }
    impliedKind = def.impliedKind;
  }
  if (kindConflict) impliedKind = undefined;

  // Step 2: build per-key term groups, preserving first-seen key order.
  const grouped = groupByKey(chips);
  const groupTerms: string[] = [];
  for (const [, group] of grouped) {
    const terms = group.map(termFor).filter((t): t is string => !!t);
    if (terms.length === 0) continue;
    if (terms.length === 1) {
      groupTerms.push(terms[0]);
    } else {
      groupTerms.push(`(${terms.join(' and ')})`);
    }
  }

  if (groupTerms.length === 0) {
    return { filter: '', freetext: trimmedFree, impliedKind };
  }

  const parts: string[] = [];
  if (impliedKind) parts.push(impliedKind);
  parts.push(...groupTerms);
  return {
    filter: parts.join(' and '),
    freetext: trimmedFree,
    impliedKind,
  };
}

/**
 * Parse a chip-encoded string (the surface form the UI roundtrips through
 * URL state). Format: `key:value` segments separated by spaces, with non
 * `key:value` segments accumulated as freetext.
 *
 * This is intentionally lenient — the picker is the authoritative source of
 * structured chips at runtime.
 */
export function parseChipString(input: string): { chips: FilterChip[]; freetext: string } {
  const chips: FilterChip[] = [];
  const free: string[] = [];
  // Match `key:"quoted value"` or `key:bare-value` or freetext.
  const re = /(\w+):(?:"([^"]*)"|(\S+))|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const key = m[1];
    if (key && TOKEN_MAP[key]) {
      const value = (m[2] ?? m[3] ?? '').trim();
      if (value) chips.push({ key, value });
    } else {
      free.push(m[0]);
    }
  }
  return { chips, freetext: free.join(' ') };
}
