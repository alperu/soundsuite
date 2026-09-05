/**
 * DraftDetector — decide whether a document is an unfiled working copy.
 *
 * The retrieval layer must never present a draft as part of the filed record.
 * This module produces the `recordStatus` signal that ingestion persists on
 * the Document (`tags.recordStatus`) and on every LanceDB chunk row
 * (`record_status`), which citations, prompts, MCP evidence and the UI then
 * surface as "DRAFT — filing not confirmed".
 *
 * Design rules:
 *  - Conservative: `isDraft` only at confidence >= DRAFT_THRESHOLD.
 *  - The ABSENCE of a court file stamp alone never marks a draft. It only
 *    strengthens an existing draft signal.
 *  - A present file stamp strongly counters draft signals (a filed document
 *    whose body mentions "draft order" stays 'filed').
 *  - Pure text heuristics — no I/O, no model calls — so the backfill script
 *    and the pipeline share one implementation.
 */

export type RecordStatus = 'filed' | 'draft' | 'unknown';

export const RECORD_STATUSES: readonly RecordStatus[] = ['filed', 'draft', 'unknown'] as const;

/** Confidence at or above which a document is flagged as a draft. */
export const DRAFT_THRESHOLD = 0.6;

export interface DraftDetectionInput {
  fileName: string;
  /** Extracted text of the first few pages (joined). */
  firstPagesText: string;
  /** Extracted text of the last page or two — signature/date blocks live here. */
  lastPagesText?: string;
  pageCount?: number;
}

export interface DraftDetectionResult {
  isDraft: boolean;
  /** 0..1 — how strongly the evidence says "draft". */
  confidence: number;
  /** Human-readable reasons, stable identifiers first (for tests/logs). */
  signals: string[];
  /** Whether a court file stamp / e-filing header was recognised. */
  hasFileStamp: boolean;
  /** Derived status: draft when isDraft, filed when stamped, else unknown. */
  recordStatus: RecordStatus;
}

// ─── File-name signals ──────────────────────────────────────────────────────

const FILENAME_SIGNALS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\bdraft\b|[-_ ]draft(?=[-_ .]|$)|draft[-_ ]?v?\d/i, weight: 0.5, label: 'filename:draft' },
  { re: /\bredlines?\b|[-_ ]redline/i, weight: 0.35, label: 'filename:redline' },
  { re: /working[-_ ]copy/i, weight: 0.35, label: 'filename:working-copy' },
  { re: /\bwip\b|[-_ ]wip(?=[-_ .]|$)/i, weight: 0.3, label: 'filename:wip' },
  { re: /(?:^|[-_ .(])v(?:er(?:sion)?)?[-_ ]?\d{1,2}(?=[-_ .)]|$)/i, weight: 0.15, label: 'filename:version' },
];

/** Filename words that argue AGAINST draft status. */
const FILENAME_FINAL_RE = /\b(?:filed|file[-_ ]?stamped|as[-_ ]filed|signed|entered|final)\b/i;

// ─── Body signals ───────────────────────────────────────────────────────────

/** Standalone upper-case DRAFT token (watermark / header / footer). Prose
 *  mentions ("the draft agreement") are lower-case and never match. */
const DRAFT_TOKEN_RE = /(?:^|[^A-Za-z])DRAFT(?![A-Za-z])/g;
/** Document-status markers only. Bare "not filed" is deliberately EXCLUDED:
 *  in litigation prose "has not filed a supersedeas bond" is a statement about
 *  a party's conduct, not a marker on the document, and matching it flagged
 *  genuinely filed documents as drafts. */
const NOT_FOR_FILING_RE = /\bNOT\s+FOR\s+FILING\b|\bDO\s+NOT\s+FILE\b/i;
const CONFIDENTIAL_DRAFT_RE = /\bCONFIDENTIAL\s+DRAFT\b|\bDRAFT\s+(?:ONLY|COPY)\b|\bDISCUSSION\s+DRAFT\b/i;
const WORK_PRODUCT_RE = /\bATTORNEY\s+WORK\s+PRODUCT\b/i;
const PRIVILEGED_RE = /\bPRIVILEGED\s*(?:&|AND)\s*CONFIDENTIAL\b/i;

/** `[DATE]`, `[NAME OF JUDGE]`, `[insert …]`, `[TBD]`, `[__]` placeholders. */
const BRACKET_PLACEHOLDER_RE = /\[(?:insert|tbd|todo|date|name|title|party|amount|court|judge|attorney|address|xx+|_{2,}|\?+)[^\]\n]{0,40}\]/gi;
/** Signature / date lines left blank: "Dated: ______", "______ JUDGE PRESIDING". */
const BLANK_LINE_RE = /(?:dated?|signed|this|on)\s*:?\s*_{3,}|_{5,}\s*\n?\s*(?:judge|attorney|signature|presiding|for\s+(?:petitioner|respondent|plaintiff|defendant))/gi;
const TODO_RE = /\bTODO\b|\bTBD\b|\bXXX+\b|\[\s*cite\s*\]|\bCITE\s+NEEDED\b/g;

// ─── File-stamp signals (evidence the document reached the clerk) ───────────

const FILE_STAMP_RES: RegExp[] = [
  // "Filed 3/14/2024 9:02 AM" / "E-FILED: 03-14-2024" / "Received 3/14/24"
  /\b(?:e-?filed|filed|received|accepted)\b[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/i,
  // Texas e-file envelope number
  /\benvelope\s*(?:no\.?|number|#|id)?\s*:?\s*\d{5,}/i,
  /\bfiled\s+for\s+record\b/i,
  /\bfile[-\s]?stamp(?:ed)?\b/i,
  /\b(?:district|county)\s+clerk\b[\s\S]{0,120}\bfiled\b/i,
  /\bfiled\b[\s\S]{0,120}\b(?:district|county)\s+clerk\b/i,
  /\baccepted\s+by\s*:/i,
  /\bclerk\s+of\s+(?:the\s+)?court\b[\s\S]{0,80}\b(?:filed|received)\b/i,
  // Bates-style clerk pagination is a record artefact ("CR 00123")
  /\bCR\s*\d{4,}\b/,
];

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) {
    n++;
    if (!re.global) break;
    if (n > 500) break;
  }
  re.lastIndex = 0;
  return n;
}

export function hasFileStamp(text: string): boolean {
  if (!text) return false;
  return FILE_STAMP_RES.some((re) => re.test(text));
}

/**
 * Detect whether a document is a draft (unfiled working copy).
 * Pure function — safe to call from ingestion, backfills and tests.
 */
export function detectDraftStatus(input: DraftDetectionInput): DraftDetectionResult {
  const fileName = input.fileName || '';
  const first = input.firstPagesText || '';
  const last = input.lastPagesText || '';
  const body = last ? `${first}\n${last}` : first;

  const signals: string[] = [];
  let score = 0;

  // File-name signals
  for (const s of FILENAME_SIGNALS) {
    if (s.re.test(fileName)) {
      signals.push(s.label);
      score += s.weight;
    }
  }
  const filenameSaysFinal = FILENAME_FINAL_RE.test(fileName);

  // Watermark / header / footer
  const draftTokens = countMatches(DRAFT_TOKEN_RE, body);
  if (draftTokens >= 2) {
    signals.push(`body:draft-watermark(x${draftTokens})`);
    score += 0.5;
  } else if (draftTokens === 1) {
    signals.push('body:draft-token');
    score += 0.3;
  }
  if (NOT_FOR_FILING_RE.test(body)) {
    signals.push('body:not-for-filing');
    score += 0.5;
  }
  if (CONFIDENTIAL_DRAFT_RE.test(body)) {
    signals.push('body:confidential-draft');
    score += 0.3;
  }
  if (WORK_PRODUCT_RE.test(body)) {
    signals.push('body:work-product');
    score += PRIVILEGED_RE.test(body) ? 0.35 : 0.2;
  }

  // Placeholders and blanks
  const placeholders = countMatches(BRACKET_PLACEHOLDER_RE, body);
  const blanks = countMatches(BLANK_LINE_RE, body);
  const todos = countMatches(TODO_RE, body);
  if (placeholders > 0) {
    signals.push(`body:bracket-placeholders(x${placeholders})`);
    score += Math.min(0.3, 0.15 * placeholders);
  }
  if (blanks > 0) {
    signals.push(`body:blank-signature-or-date(x${blanks})`);
    score += Math.min(0.3, 0.15 * blanks);
  }
  if (todos > 0) {
    signals.push(`body:todo-markers(x${todos})`);
    score += Math.min(0.2, 0.1 * todos);
  }

  const stamped = hasFileStamp(body);
  const hadDraftSignal = score > 0;

  if (stamped) {
    signals.push('stamp:file-stamp-present');
    score -= 0.4;
  } else if (hadDraftSignal) {
    // Absence of a stamp is only meaningful alongside a positive signal.
    signals.push('stamp:no-file-stamp');
    score += 0.1;
  }
  if (filenameSaysFinal && hadDraftSignal) {
    signals.push('filename:final-marker');
    score -= 0.2;
  }

  const confidence = Math.max(0, Math.min(1, Number(score.toFixed(3))));
  const isDraft = confidence >= DRAFT_THRESHOLD;
  const recordStatus: RecordStatus = isDraft ? 'draft' : stamped ? 'filed' : 'unknown';

  return { isDraft, confidence, signals, hasFileStamp: stamped, recordStatus };
}

/** Normalise any stored value to a RecordStatus (unknown for junk/absent). */
export function normalizeRecordStatus(value: unknown): RecordStatus {
  return value === 'draft' || value === 'filed' ? value : 'unknown';
}

/** Read the record status off a Document's `tags` JSON bag. */
export function recordStatusFromTags(tags: unknown): RecordStatus {
  if (!tags || typeof tags !== 'object') return 'unknown';
  return normalizeRecordStatus((tags as Record<string, unknown>).recordStatus);
}

/** Marker appended to citations of draft sources. */
export const DRAFT_CITE_MARKER = 'DRAFT, filing not confirmed';
