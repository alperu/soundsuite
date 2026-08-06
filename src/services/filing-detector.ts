/**
 * FilingDetector — auto-detect filing type and title from PDF filename,
 * parent folder name, and header text (first 5 pages).
 *
 * Handles real legal document naming patterns:
 *   - "D-1-FM-25-000222 - MOTION FOR RECONSIDERATION.pdf"
 *   - "PetitionOfBillofReviewFinal.pdf"
 *   - "527222.pdf" (numeric-only → falls back to folder name)
 *   - Parent folders like "Motion to Strike/" or "NOTICE OF APPEAL/"
 */

import * as path from 'path';

export const FILING_TYPES = [
  'Motion', 'Notice', 'Letter', 'Order', 'Petition', 'Affidavit',
  'Subpoena', 'Brief', 'Response', 'Reply', 'Judgment', 'Decree',
  "Clerk's Record", "Reporter's Record",
  'Transcript', 'Settlement', 'Bill of Review', 'Return of Service',
  'Demand Letter', 'Objection', 'Request', 'Supplement', 'Designation',
  'Other',
] as const;

/**
 * Keyword patterns for each filing type.
 * Order matters — more specific patterns first to avoid false positives.
 */
const TYPE_PATTERNS: Array<{ type: string; patterns: RegExp[] }> = [
  // Very specific multi-word types first
  { type: 'Bill of Review', patterns: [/bill\s+of\s+review/i] },
  { type: 'Return of Service', patterns: [/return\s+of\s+service/i] },
  { type: 'Demand Letter', patterns: [/demand\s+letter/i] },
  { type: "Clerk's Record", patterns: [
    /clerk'?s?\s+record/i,
    // CR abbreviation as a standalone token. Leading \b prevents match
    // inside words ("secretary", "lecture"). Trailing lookahead requires a
    // volume/page/numeric token so we don't catch "-CR" suffixes etc. We
    // drop the trailing \b because between a trailing dot and whitespace
    // there is no word boundary; the lookahead alone anchors.
    /\bC\.?\s*R\.?(?=\s+(?:vol(?:ume)?|page|p\.?|\d))/i,
  ] },
  { type: "Reporter's Record", patterns: [
    /reporter'?s?\s+record/i,
    // RR abbreviation. Same shape as CR above — requires a following
    // volume/page/numeric token so "RR" isn't matched in legal phrases like
    // "ERR" or "Carrera." Covers: "RR", "R.R.", "Supp RR", "2nd Supp RR Vol 2"
    /\bR\.?\s*R\.?(?=\s+(?:vol(?:ume)?|page|p\.?|\d))/i,
    // Standalone "Supp RR" / "Supplemental RR" — anchors filenames like
    // "1 Supp. RR" that don't always have a numeric Vol after the RR.
    /\b(?:supp(?:lemental|lement)?\.?)\s+R\.?\s*R\.?\b/i,
  ] },
  // Single-word types, ordered by specificity
  { type: 'Transcript', patterns: [/transcript/i, /\bdeposition\b/i] },
  { type: 'Settlement', patterns: [/settlement/i, /\bmediat/i] },
  { type: 'Affidavit', patterns: [/affidavit/i, /\bsworn\s+(?:statement|declaration)/i] },
  { type: 'Subpoena', patterns: [/subpoena/i, /\bduces\s+tecum\b/i] },
  { type: 'Designation', patterns: [/designation/i] },
  // "Supp" / "Supplement" intentionally ranked AFTER Reporter's Record and
  // Clerk's Record so a filename like "2nd Supp RR Vol 2" picks up RR rather
  // than the modifier "Supp". The earlier regexes consume the combined token.
  { type: 'Supplement', patterns: [/supplement/i] },
  { type: 'Petition', patterns: [/petition/i] },
  { type: 'Judgment', patterns: [/judgment/i, /\bjudgement\b/i] },
  { type: 'Decree', patterns: [/decree/i] },
  { type: 'Objection', patterns: [/objection/i] },
  { type: 'Request', patterns: [/request\b/i] },
  { type: 'Motion', patterns: [/motion/i, /\bemergency\s+mot/i] },
  { type: 'Brief', patterns: [/brief/i] },
  { type: 'Response', patterns: [/response/i, /\bopposition\b/i] },
  { type: 'Reply', patterns: [/reply/i] },
  { type: 'Order', patterns: [/\border\b/i, /\bruling\b/i] },
  { type: 'Notice', patterns: [/notice/i, /\bnotification\b/i] },
  { type: 'Letter', patterns: [/letter/i, /\bcorrespondence\b/i] },
];

// ── Case number prefix pattern ──────────────────────────────────────
// Matches: "D-1-FM-25-000222 - ", "D-1-FM-25-000222-", or similar court case prefixes
const CASE_NUMBER_PREFIX = /^[A-Z]-\d+-[A-Z]+-\d+-\d+\s*[-–—]\s*/i;

// Also match generic docket-style prefixes: "2025-CV-1234 - ", "FM-25-000222 - "
const DOCKET_PREFIX = /^[A-Z]{1,4}[-_.]\d{2,6}[-_.]\d{3,8}\s*[-–—]\s*/i;

// ── Patterns to strip from filenames ────────────────────────────────
const STRIP_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: CASE_NUMBER_PREFIX, description: 'Full case number prefix' },
  { pattern: DOCKET_PREFIX, description: 'Docket-style prefix' },
  { pattern: /^\d{4}[-_.]\d{2}[-_.]\d{2}\s*[-–—]?\s*/i, description: 'Date prefix' },
  { pattern: /^\d+[-_.]\s*/i, description: 'Numeric prefix' },
  { pattern: /\s*[-–—_]\s*(?:signed|filed|final|copy|scan(?:ned)?|compressed)\s*$/i, description: 'Status suffix' },
  { pattern: /\s*[-–—_]?\s*V\d+\s*$/i, description: 'Version suffix V2, V3...' },
  { pattern: /\s*\(\d+\)\s*$/i, description: 'Trailing (1), (2)' },
  { pattern: /\s*[-–—]\s*\d+\s*$/i, description: 'Trailing - 1, - 2' },
  { pattern: /\s*compressed\s*$/i, description: 'Trailing Compressed' },
];

export interface FilingDetection {
  filingType: string;
  title: string;
  confidence: number; // 0-1
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Split CamelCase or PascalCase into words.
 * "PetitionOfBillofReviewFinal" → "Petition Of Billof Review Final"
 * Also handles "MotionToStrike" → "Motion To Strike"
 */
function splitCamelCase(str: string): string {
  return str
    // Insert space before uppercase letter preceded by lowercase
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Insert space before uppercase letter preceded by another uppercase + lowercase
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/**
 * Extract the parent folder name from a file path.
 * "/cases/Motion to Strike/doc.pdf" → "Motion to Strike"
 */
function getParentFolderName(filePath: string): string {
  const dir = path.dirname(filePath);
  return path.basename(dir);
}

/**
 * Check if a filename is essentially numeric-only (no meaningful text).
 * "527222.pdf" → true, "527222 - Motion.pdf" → false
 */
function isNumericFilename(baseName: string): boolean {
  const stripped = baseName.replace(/[-_.\s]/g, '');
  return /^\d+$/.test(stripped);
}

/**
 * Clean a raw title string: normalize whitespace, fix common issues.
 */
function cleanTitle(raw: string): string {
  return raw
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Title-case a string: capitalize first letter of each word.
 */
function toTitleCase(str: string): string {
  const lowerWords = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'of', 'to', 'in', 'on', 'at', 'by', 'with']);
  return str
    .split(/\s+/)
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i === 0 || !lowerWords.has(lower)) {
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
      return lower;
    })
    .join(' ');
}

// ── Core detection functions ────────────────────────────────────────

/**
 * Words that are adjective modifiers, not primary filing nouns.
 * "Supplemental Affidavit" → "Supplemental" is a modifier, "Affidavit" is the type.
 */
const MODIFIER_WORDS = /\b(?:supplemental|amended|emergency|original|corrected|revised|proposed|preliminary|final)\b/i;

/**
 * Party-role words that describe WHO filed, not WHAT was filed.
 * "PETITIONER John Doe Amended BRIEF" → "PETITIONER" is a party role, "BRIEF" is the type.
 * These should be skipped entirely during type detection.
 */
const PARTY_ROLE_WORDS = /\b(?:petitioner'?s?|respondent'?s?|appellant'?s?|appellee'?s?|plaintiff'?s?|defendant'?s?|movant'?s?|applicant'?s?|claimant'?s?)\b/i;

/**
 * Prepositional phrases that introduce secondary/subordinate references.
 * Everything after these phrases is context, not the primary filing type.
 * "AFFIDAVIT IN SUPPORT OF PETITION FOR BILL OF REVIEW"
 *   → primary = AFFIDAVIT, everything after "IN SUPPORT OF" is subordinate
 */
const SUBORDINATE_BOUNDARY = /\b(?:in\s+support\s+of|in\s+opposition\s+to|in\s+response\s+to|in\s+reply\s+to|regarding|concerning|re:|for\s+(?:a|the)?)\b/i;

/**
 * Find the position of the first regex match in a string.
 * Returns -1 if not found.
 */
function matchPosition(text: string, pattern: RegExp): number {
  const m = text.match(pattern);
  return m && m.index !== undefined ? m.index : -1;
}

/**
 * Strip the case number prefix from a title string to get the descriptive part.
 * "Cause No. D-1-FM-25-000222 - SUPPLEMENTAL AFFIDAVIT..." → "SUPPLEMENTAL AFFIDAVIT..."
 * "D-1-FM-25-000222 - MOTION..." → "MOTION..."
 */
function stripCasePrefix(text: string): string {
  return text
    .replace(/^Cause\s+No\.?\s*/i, '')
    .replace(CASE_NUMBER_PREFIX, '')
    .replace(DOCKET_PREFIX, '')
    .replace(/^\s*[-–—]\s*/, '')
    .trim();
}

/**
 * Detect the filing type from filename, folder name, and optional header text.
 *
 * Strategy: In the filename (after stripping case number prefix), find the
 * FIRST type keyword that isn't a modifier word. That's the primary type.
 *
 * For "SUPPLEMENTAL AFFIDAVIT IN SUPPORT OF PETITION FOR BILL OF REVIEW":
 *   - "SUPPLEMENTAL" → modifier, skip
 *   - "AFFIDAVIT" → first real type keyword → this is the primary type
 *   - "PETITION", "BILL OF REVIEW" → appear after subordinate boundary, ignored
 *
 * Folder name and header text are used as secondary signals to boost confidence.
 */
export function detectFilingType(
  fileName: string,
  headerText?: string,
  folderName?: string
): { type: string; confidence: number } {
  const rawName = splitCamelCase(path.basename(fileName, path.extname(fileName)));
  const fileNameClean = stripCasePrefix(rawName);

  // ── Step 1: Find the primary type from the filename ──────────────
  // Strip party-role words from the text so "PETITIONER" doesn't match "Petition".
  // This handles "PETITIONER John Doe Amended BRIEF" → finds "BRIEF" as the type.
  const partyStripped = fileNameClean.replace(PARTY_ROLE_WORDS, '').trim() || fileNameClean;

  // Split the filename at subordinate boundaries. Only the part BEFORE
  // the first boundary contains the primary filing type.
  const boundaryPos = matchPosition(partyStripped, SUBORDINATE_BOUNDARY);
  const primaryPart = boundaryPos > 0
    ? partyStripped.substring(0, boundaryPos).trim()
    : partyStripped;

  // Find the first non-modifier type keyword in the primary part
  let primaryType: string | null = null;
  let primaryPos = Infinity;

  for (const { type, patterns } of TYPE_PATTERNS) {
    for (const pattern of patterns) {
      const pos = matchPosition(primaryPart, pattern);
      if (pos === -1) continue;

      // Check if this match is just a modifier word (e.g. "supplemental" matching "supplement")
      // or a party-role word (e.g. "petitioner" matching "petition")
      const surroundingText = primaryPart.substring(
        Math.max(0, pos - 1),
        pos + type.length + 12
      );
      if ((MODIFIER_WORDS.test(surroundingText) || PARTY_ROLE_WORDS.test(surroundingText)) && pos < primaryPart.length / 2) {
        // This is a modifier or party role — skip it, keep looking for a real noun
        continue;
      }

      // This is a real type keyword — take the earliest one
      if (pos < primaryPos) {
        primaryPos = pos;
        primaryType = type;
      }
    }
  }

  // If no non-modifier type found in primary part, check the full filename
  // (but still prefer earlier matches, and still skip party-role words)
  if (!primaryType) {
    for (const { type, patterns } of TYPE_PATTERNS) {
      for (const pattern of patterns) {
        const pos = matchPosition(partyStripped, pattern);
        if (pos === -1) continue;
        const surroundingFull = partyStripped.substring(
          Math.max(0, pos - 1),
          pos + type.length + 12
        );
        if (PARTY_ROLE_WORDS.test(surroundingFull)) continue;
        if (pos < primaryPos) {
          primaryPos = pos;
          primaryType = type;
        }
      }
    }
  }

  // ── Step 2: Check folder name and header for supporting signals ──
  let folderType: string | null = null;
  for (const { type, patterns } of TYPE_PATTERNS) {
    for (const pattern of patterns) {
      if (folderName && pattern.test(folderName)) {
        if (!folderType) folderType = type;
      }
    }
  }

  let headerType: string | null = null;
  if (headerText) {
    // Only check first 500 chars of header for type detection
    const headerSnippet = headerText.substring(0, 500);
    for (const { type, patterns } of TYPE_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(headerSnippet)) {
          if (!headerType) headerType = type;
        }
      }
    }
  }

  // ── Step 3: Determine final type and confidence ──────────────────
  if (!primaryType && !folderType && !headerType) {
    return { type: 'Other', confidence: 0.2 };
  }

  // Primary type from filename wins
  const finalType = primaryType || folderType || headerType || 'Other';
  let confidence = primaryType ? 0.85 : folderType ? 0.75 : 0.60;

  // Boost when multiple signals agree
  const signals = [primaryType, folderType, headerType].filter(Boolean);
  const agreeing = signals.filter(t => t === finalType).length;
  if (agreeing >= 3) confidence = Math.min(confidence + 0.12, 0.99);
  else if (agreeing >= 2) confidence = Math.min(confidence + 0.08, 0.97);

  return { type: finalType, confidence };
}

/**
 * Extract a clean filing title from the filename, folder name, or header text.
 *
 * Priority:
 * 1. Case-number-prefixed filename → strip prefix, use remainder as title
 * 2. Descriptive filename → clean and use
 * 3. Numeric-only filename → fall back to parent folder name
 * 4. Header text → extract title from first lines
 */
export function extractFilingTitle(
  fileName: string,
  headerText?: string,
  folderName?: string
): string {
  const ext = path.extname(fileName);
  let baseName = path.basename(fileName, ext);

  // Step 1: Handle CamelCase filenames
  baseName = splitCamelCase(baseName);

  // Step 2: Strip case number prefix ("D-1-FM-25-000222 - MOTION...")
  let title = baseName;
  if (CASE_NUMBER_PREFIX.test(title)) {
    title = title.replace(CASE_NUMBER_PREFIX, '');
  } else if (DOCKET_PREFIX.test(title)) {
    title = title.replace(DOCKET_PREFIX, '');
  }

  // Step 3: Strip other patterns (version suffixes, "Compressed", etc.)
  for (const { pattern } of STRIP_PATTERNS) {
    title = title.replace(pattern, '');
  }
  title = cleanTitle(title);

  // Step 4: If what remains is numeric-only or too short, fall back to folder name
  if (isNumericFilename(title) || title.length < 3) {
    if (folderName && folderName.length >= 3 && !isNumericFilename(folderName)) {
      title = cleanTitle(folderName);
    } else if (headerText) {
      const headerTitle = extractTitleFromHeader(headerText);
      if (headerTitle) return headerTitle;
    }
    // Last resort: use the original basename cleaned up
    if (title.length < 3) {
      title = cleanTitle(baseName);
    }
  }

  // Step 5: If title is ALL CAPS, convert to Title Case for readability
  if (title === title.toUpperCase() && title.length > 3) {
    title = toTitleCase(title);
  }

  // Step 6: If header text has a significantly better title, consider it
  if (headerText) {
    const headerTitle = extractTitleFromHeader(headerText);
    if (headerTitle && headerTitle.length > title.length * 1.5 && headerTitle.length < 200) {
      // Only prefer header if it's substantially more descriptive
      title = headerTitle;
    }
  }

  return title || baseName;
}

/**
 * Extract a title from the first few lines of header text.
 * Looks for lines that contain filing type keywords and are reasonably short.
 */
function extractTitleFromHeader(text: string): string | null {
  const lines = text
    .substring(0, 1500) // More text since we now extract 5 pages
    .split(/\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // Skip preamble lines (court name, cause number, parties)
  const skipPatterns = [
    /^(?:IN\s+THE|CAUSE\s+NO|NO\.\s*\d|CASE\s+NO|COUNTY\s+OF|STATE\s+OF|DISTRICT\s+COURT)/i,
    /^(?:VS?\.?\s*$|PLAINTIFF|DEFENDANT|PETITIONER|RESPONDENT|APPELLANT|APPELLEE)/i,
    /^\d+(?:ST|ND|RD|TH)\s+(?:JUDICIAL|DISTRICT)/i,
  ];

  for (const line of lines.slice(0, 20)) {
    if (line.length < 5 || line.length > 150) continue;

    // Skip preamble
    if (skipPatterns.some(p => p.test(line))) continue;

    // Check if line contains a filing type keyword
    for (const { patterns } of TYPE_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          let cleaned = line.trim();
          // Remove leading/trailing punctuation
          cleaned = cleaned.replace(/^[:\-–—\s]+|[:\-–—\s]+$/g, '').trim();
          if (cleaned.length >= 8 && cleaned.length <= 150) {
            // Title-case if all caps
            if (cleaned === cleaned.toUpperCase()) {
              cleaned = toTitleCase(cleaned);
            }
            return cleaned;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Quick-extract header text from the first 5 pages of a PDF.
 * Lightweight — doesn't do full ingestion, just text extraction.
 */
export async function quickExtractHeader(filePath: string): Promise<string> {
  try {
    // Polyfill DOMMatrix for Node.js (pdfjs-dist requires it)
    if (typeof globalThis.DOMMatrix === 'undefined') {
      (globalThis as any).DOMMatrix = class DOMMatrix {
        a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
        constructor(init?: any) { if (Array.isArray(init) && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init; }
        multiplySelf() { return this; } inverse() { return new DOMMatrix(); }
        static fromMatrix() { return new DOMMatrix(); }
        static fromFloat32Array(a: Float32Array) { return new DOMMatrix(Array.from(a)); }
        static fromFloat64Array(a: Float64Array) { return new DOMMatrix(Array.from(a)); }
      };
    }
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { getDocument, GlobalWorkerOptions } = pdfjsLib as any;
    const pathMod = await import('path');
    const fsMod = await import('fs/promises');

    GlobalWorkerOptions.workerPort = null;
    const standardFontDataUrl = pathMod.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/');

    const fileBuffer = await fsMod.readFile(filePath);
    const data = new Uint8Array(fileBuffer);
    const doc = await getDocument({ data, standardFontDataUrl }).promise;

    const maxPages = Math.min(doc.numPages, 5);
    const texts: string[] = [];

    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item: any) => item.str).join(' ');
      texts.push(pageText);
    }

    return texts.join('\n');
  } catch (error) {
    console.warn('quickExtractHeader failed:', error instanceof Error ? error.message : error);
    return '';
  }
}

/**
 * Full detection pipeline: extract header + detect type + extract title.
 * Uses filename, parent folder name, and PDF header text as signals.
 *
 * Detection is **header-aware**: the document's first-page title is the
 * authoritative signal when present. The filename is the fallback for the
 * (common) case where PDF text extraction fails or the header is ambiguous.
 * See classifyFilingHybrid() for the resolution rules.
 */
export async function detectFiling(filePath: string): Promise<FilingDetection> {
  const fileName = path.basename(filePath);
  const folderName = getParentFolderName(filePath);
  const headerText = await quickExtractHeader(filePath);

  const hybrid = classifyFilingHybrid({ fileName, headerText, folderName });
  const title = extractFilingTitle(fileName, headerText, folderName);

  return { filingType: hybrid.filingType, title, confidence: hybrid.confidence };
}

// ── Header-text-aware classifier ────────────────────────────────────
//
// The filename classifier above is fooled by documents that *mention* a
// different filing type (e.g. a Response that names the Petition it opposes).
// `classifyFilingFromHeader` scans the first ~1000 chars of extracted page-1
// text for a strong **title** pattern (top of the document, not a body
// reference). When it returns `high` confidence, the hybrid wrapper trusts
// it over the filename signal.

/** Lowercase kind tokens emitted by the header classifier. */
export type HeaderClassifierKind =
  | 'response'
  | 'motion'
  | 'notice'
  | 'order'
  | 'proposedOrder'
  | 'brief'
  | 'reportersRecord'
  | 'clerksRecord'
  | 'affidavit'
  | 'subpoena'
  | 'judgment'
  | 'rfa'
  | 'petition'
  | 'billOfReview';

export interface HeaderClassifierResult {
  kind: HeaderClassifierKind;
  confidence: 'high' | 'medium' | 'low';
  matched: string;
}

/**
 * Strip the caption/cause-number block off the top of a header so the
 * pattern-scanner doesn't match party-role nouns or court names. Each
 * pattern is bounded so it can't eat past the line it lives on — the
 * actual title (RESPONSE / MOTION / …) is usually a few lines below.
 */
function stripHeaderPreamble(text: string): string {
  return text
    // "NO. D-1-FM-25-000222" / "CAUSE NO. 12345" — strict token shape, single
    // line. Require `.` or whitespace after `NO` so we don't eat "NOTICE".
    .replace(/\b(?:CAUSE\s+)?NO(?:\.\s*|\s+)[A-Z0-9][A-Z0-9-]{2,}/gi, ' ')
    // "IN THE … COURT OF … TEXAS" — single line, terminates at "TEXAS" or newline.
    .replace(/\bIN\s+THE\b[^\n]*?\b(?:DISTRICT|COUNTY|JUDICIAL|APPELLATE|SUPREME)\b[^\n]*?\bTEXAS\b/gi, ' ')
    // Trailing court-name fragments on their own line ("…COURT OF TRAVIS COUNTY, TEXAS")
    .replace(/^[^\n]*\bCOURT\s+OF\s+[A-Z][A-Z\s,'-]*\bTEXAS\b/gim, ' ')
    // Common caption tokens followed by separator (RESPONDENT, / PLAINTIFF§ / …)
    .replace(/\b(?:PETITIONER|RESPONDENT|PLAINTIFF|DEFENDANT|APPELLANT|APPELLEE)\s*[,§]/gi, ' ')
    // Section markers used in TX captions
    .replace(/[§]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ordered rule table — first match wins. Strong title patterns are scanned
 * BEFORE generic petition/bill-of-review fallbacks (those are the most
 * common "wrong" classification when a Response mentions a Petition in its
 * title). Patterns are case-insensitive and anchored near the top of the
 * document; we only feed the first ~1000 chars after caption stripping.
 */
const HEADER_RULES: Array<{
  re: RegExp;
  kind: HeaderClassifierKind;
  confidence: 'high' | 'medium' | 'low';
}> = [
  // Responses & replies — match FIRST so "RESPONSE … TO … PETITION" wins.
  { re: /\bRESPONDENT'?S?\s+RESPONSE\b/i, kind: 'response', confidence: 'high' },
  { re: /\bRESPONSE\s+IN\s+OPPOSITION\s+TO\b/i, kind: 'response', confidence: 'high' },
  { re: /\bRESPONSE\s+TO\b/i, kind: 'response', confidence: 'high' },
  { re: /\bREPLY\s+(?:TO|IN\s+SUPPORT)\b/i, kind: 'response', confidence: 'high' },
  { re: /\bSUR-?REPLY\b/i, kind: 'response', confidence: 'high' },

  // Motions
  { re: /\bOPPOSED\s+MOTION\b/i, kind: 'motion', confidence: 'high' },
  { re: /\bEMERGENCY\s+MOTION\b/i, kind: 'motion', confidence: 'high' },
  { re: /\bMOTION\s+TO\s+\w+/i, kind: 'motion', confidence: 'high' },
  { re: /\bMOTION\s+FOR\s+\w+/i, kind: 'motion', confidence: 'high' },
  { re: /\bMOTION\s+IN\s+LIMINE\b/i, kind: 'motion', confidence: 'high' },

  // Orders — proposed first (more specific)
  { re: /\bPROPOSED\s+ORDER\b/i, kind: 'proposedOrder', confidence: 'high' },
  { re: /\bORDER\s+ON\b/i, kind: 'order', confidence: 'high' },
  { re: /\bORDER\s+GRANTING\b/i, kind: 'order', confidence: 'high' },
  { re: /\bORDER\s+DENYING\b/i, kind: 'order', confidence: 'high' },
  { re: /(^|[\s>])ORDER(?:\s|$)/i, kind: 'order', confidence: 'medium' },

  // Briefs
  { re: /\bAPPELLANT'?S?\s+BRIEF\b/i, kind: 'brief', confidence: 'high' },
  { re: /\bAPPELLEE'?S?\s+BRIEF\b/i, kind: 'brief', confidence: 'high' },
  { re: /\bBRIEF\s+(?:OF|FOR|IN)\b/i, kind: 'brief', confidence: 'high' },

  // Records
  { re: /\bREPORTER'?S?\s+RECORD\b/i, kind: 'reportersRecord', confidence: 'high' },
  { re: /\bCOURT\s+REPORTER\b/i, kind: 'reportersRecord', confidence: 'high' },
  { re: /\bCLERK'?S?\s+RECORD\b/i, kind: 'clerksRecord', confidence: 'high' },

  // Affidavits / declarations / subpoenas / judgments
  { re: /\bSUBPOENA\b/i, kind: 'subpoena', confidence: 'high' },
  { re: /\bAFFIDAVIT\s+(?:OF|IN\s+SUPPORT)\b/i, kind: 'affidavit', confidence: 'medium' },
  { re: /\bDECLARATION\s+OF\b/i, kind: 'affidavit', confidence: 'medium' },
  { re: /\bJUDGMENT\b/i, kind: 'judgment', confidence: 'medium' },

  // Notice — must NOT be preceded by "in support of" within ~30 chars.
  // We approximate the lookbehind by post-filtering in matchOnce.
  { re: /\bNOTICE\s+OF\s+\w+/i, kind: 'notice', confidence: 'high' },

  // Request for admissions / RFAs
  { re: /\bREQUEST\s+FOR\s+ADMISSIONS?\b/i, kind: 'rfa', confidence: 'high' },
  { re: /\bDEEMED\s+ADMISSIONS?\b/i, kind: 'rfa', confidence: 'high' },
  { re: /\bRFA\b/i, kind: 'rfa', confidence: 'medium' },

  // Generic fallbacks LAST — only matched if nothing stronger fired.
  { re: /\bBILL\s+OF\s+REVIEW\b/i, kind: 'billOfReview', confidence: 'medium' },
  { re: /(^|[\s>])PETITION(?:\s|$)/i, kind: 'petition', confidence: 'medium' },
];

/**
 * Scan the top of a document's extracted text for a strong title pattern.
 * Returns null when no rule matches. The caller decides whether to trust
 * the result over the filename signal (see classifyFilingHybrid).
 */
export function classifyFilingFromHeader(
  text: string,
): HeaderClassifierResult | null {
  if (!text || typeof text !== 'string') return null;

  // Limit scan to the first ~1000 chars after stripping the caption block.
  // The caption block (cause number, party names, court name) at the top of
  // every TX filing would otherwise generate false positives.
  const raw = text.slice(0, 2000);
  const stripped = stripHeaderPreamble(raw).slice(0, 1000);
  if (stripped.length < 5) return null;

  // Strategy: scan every rule, take the EARLIEST position match. Ties on
  // position go to the rule that appears first in HEADER_RULES (i.e. the
  // more specific one, since the table is ordered specific → generic).
  // This is what fixes "ORDER GRANTING MOTION FOR SUMMARY JUDGMENT" — both
  // ORDER and MOTION patterns match, but ORDER's position (0) wins.
  let bestIdx = -1;
  let bestPos = Number.POSITIVE_INFINITY;
  let bestMatch = '';

  for (let i = 0; i < HEADER_RULES.length; i++) {
    const rule = HEADER_RULES[i];
    const m = stripped.match(rule.re);
    if (!m || m.index === undefined) continue;

    // Special-case NOTICE: skip if preceded by "in support of" within 30 chars.
    if (rule.kind === 'notice') {
      const before = stripped.slice(Math.max(0, m.index - 30), m.index);
      if (/\bin\s+support\s+of\b/i.test(before)) continue;
    }

    if (m.index < bestPos) {
      bestPos = m.index;
      bestIdx = i;
      bestMatch = m[0].trim();
    }
  }

  if (bestIdx === -1) return null;
  const rule = HEADER_RULES[bestIdx];
  return { kind: rule.kind, confidence: rule.confidence, matched: bestMatch };
}

/**
 * Map a HeaderClassifierKind (lowercase token) to the PascalCase
 * `Filing.filingType` value stored in the database. Keep in sync with the
 * canonical list in FILING_TYPES above and FILING_TYPE_TO_KIND in
 * src/lib/filings/classify-entity-kind.ts.
 *
 * Notes:
 *   - `rfa` collapses to 'Request' (closest existing canonical type).
 *   - `proposedOrder` collapses to 'Order' (downstream EntityKind routing
 *     uses the per-Motion attachment kind for the proposed-order distinction).
 */
export function kindToFilingType(kind: HeaderClassifierKind): string {
  switch (kind) {
    case 'response': return 'Response';
    case 'motion': return 'Motion';
    case 'notice': return 'Notice';
    case 'order': return 'Order';
    case 'proposedOrder': return 'Order';
    case 'brief': return 'Brief';
    case 'reportersRecord': return "Reporter's Record";
    case 'clerksRecord': return "Clerk's Record";
    case 'affidavit': return 'Affidavit';
    case 'subpoena': return 'Subpoena';
    case 'judgment': return 'Judgment';
    case 'rfa': return 'Request';
    case 'petition': return 'Petition';
    case 'billOfReview': return 'Bill of Review';
  }
}

/** Source attribution for a hybrid classification result. */
export type HybridSource = 'header' | 'filename' | 'hybrid';

export interface HybridClassification {
  /** PascalCase canonical Filing.filingType (e.g. 'Response', 'Motion'). */
  filingType: string;
  source: HybridSource;
  confidence: number;
  /** When the header rule fired, the matched substring (debug aid). */
  matched?: string;
}

/**
 * Resolve the filing type using both the filename signal (existing
 * `detectFilingType`) and the document's first-page text. Header wins on
 * `high` confidence; on `medium` it only wins if the filename produced a
 * generic fallback (`petition` / `billOfReview`) that's most often the
 * misclassification we're trying to fix.
 */
export function classifyFilingHybrid(args: {
  fileName: string;
  headerText?: string;
  folderName?: string;
}): HybridClassification {
  const { fileName, headerText, folderName } = args;

  // Filename signal: existing detector (unchanged).
  const filenameSignal = detectFilingType(fileName, undefined, folderName);
  const filenameType = filenameSignal.type;
  const filenameConfidence = filenameSignal.confidence;

  // Header signal (if any).
  const headerResult = headerText ? classifyFilingFromHeader(headerText) : null;

  if (!headerResult) {
    // No header signal — pure filename path (back-compat with PDFs that
    // failed text extraction).
    return {
      filingType: filenameType,
      source: 'filename',
      confidence: filenameConfidence,
    };
  }

  const headerType = kindToFilingType(headerResult.kind);

  // High-confidence header always wins. This is THE fix for the bug:
  // "RESPONDENT'S RESPONSE IN OPPOSITION TO PETITION TO ENFORCE…"
  // → header says Response (high), filename says Petition → Response wins.
  if (headerResult.confidence === 'high') {
    return {
      filingType: headerType,
      source: 'header',
      confidence: 0.95,
      matched: headerResult.matched,
    };
  }

  // Medium-confidence header — only override when filename produced a
  // generic fallback that's prone to misclassification (petition / bill of
  // review). Other filename kinds (Motion, Order, etc.) keep their signal.
  if (headerResult.confidence === 'medium') {
    const filenameIsFallback =
      filenameType === 'Petition' ||
      filenameType === 'Bill of Review' ||
      filenameType === 'Other';
    if (filenameIsFallback && headerType !== filenameType) {
      return {
        filingType: headerType,
        source: 'hybrid',
        confidence: Math.max(0.7, filenameConfidence),
        matched: headerResult.matched,
      };
    }
  }

  // Otherwise filename wins.
  return {
    filingType: filenameType,
    source: 'filename',
    confidence: filenameConfidence,
    matched: headerResult.matched,
  };
}
