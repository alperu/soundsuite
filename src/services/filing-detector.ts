/**
 * FilingDetector — auto-detect filing type and title from PDF filename,
 * parent folder name, and header text (first 5 pages).
 *
 * Handles real legal document naming patterns:
 *   - "D-1-FM-25-004488 - MOTION FOR RECONSIDERATION.pdf"
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
  { type: "Clerk's Record", patterns: [/clerk'?s?\s+record/i] },
  { type: "Reporter's Record", patterns: [/reporter'?s?\s+record/i] },
  // Single-word types, ordered by specificity
  { type: 'Transcript', patterns: [/transcript/i, /\bdeposition\b/i] },
  { type: 'Settlement', patterns: [/settlement/i, /\bmediat/i] },
  { type: 'Affidavit', patterns: [/affidavit/i, /\bsworn\s+(?:statement|declaration)/i] },
  { type: 'Subpoena', patterns: [/subpoena/i, /\bduces\s+tecum\b/i] },
  { type: 'Designation', patterns: [/designation/i] },
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
// Matches: "D-1-FM-25-004488 - ", "D-1-FM-25-004488-", or similar court case prefixes
const CASE_NUMBER_PREFIX = /^[A-Z]-\d+-[A-Z]+-\d+-\d+\s*[-–—]\s*/i;

// Also match generic docket-style prefixes: "2025-CV-1234 - ", "FM-25-004488 - "
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
 * "PETITIONER Alper Uzmezler Amended BRIEF" → "PETITIONER" is a party role, "BRIEF" is the type.
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
 * "Cause No. D-1-FM-25-004488 - SUPPLEMENTAL AFFIDAVIT..." → "SUPPLEMENTAL AFFIDAVIT..."
 * "D-1-FM-25-004488 - MOTION..." → "MOTION..."
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
  // This handles "PETITIONER Alper Uzmezler Amended BRIEF" → finds "BRIEF" as the type.
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

  // Step 2: Strip case number prefix ("D-1-FM-25-004488 - MOTION...")
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
 */
export async function detectFiling(filePath: string): Promise<FilingDetection> {
  const fileName = path.basename(filePath);
  const folderName = getParentFolderName(filePath);
  const headerText = await quickExtractHeader(filePath);

  const { type, confidence } = detectFilingType(fileName, headerText, folderName);
  const title = extractFilingTitle(fileName, headerText, folderName);

  return { filingType: type, title, confidence };
}
