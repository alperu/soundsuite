/**
 * Detect line numbers from Reporter's Record (RR) transcript text.
 *
 * Texas court reporter transcripts number lines 1-25 per page.
 * Each line typically starts with a number followed by whitespace.
 * This detector finds the range of line numbers present in a chunk of text.
 *
 * Multiple detection strategies handle different extraction quality:
 * 1. Primary: line starts with number + double-space (layout-aware extraction)
 * 2. Relaxed: line starts with number + single space followed by Q/A/THE/BY etc.
 * 3. Collapsed header: pdfdown collapses line numbers into "1 2 3 4 ... 25"
 */

/** Primary pattern: line starts with a number 1-25, followed by at least one space/tab */
const LINE_NUMBER_PATTERN = /^[ \t]*(\d{1,2})[ \t]{2,}/gm;

/** Relaxed pattern: number + single space + common RR content starters (Q., A., THE, BY, etc.) */
const RELAXED_LINE_PATTERN = /^[ \t]*(\d{1,2}) (?:Q\.|A\.|THE |BY |MR\.|MS\.|MRS\.|JUDGE|COURT|WITNESS)/gm;

/** Collapsed header pattern: "1 2 3 4 5 6 7 ... 25" all on one line (pdfdown artifact) */
const COLLAPSED_HEADER_PATTERN = /^((?:\d{1,2}\s+){5,})\s*$/m;

export interface LineRange {
  /** First line number detected in the text (1-25) */
  startLine?: number;
  /** Last line number detected in the text (1-25) */
  endLine?: number;
}

/**
 * Detect line number range from RR transcript text.
 *
 * Tries multiple strategies in order of reliability:
 * 1. Primary pattern (number + 2+ spaces at line start)
 * 2. Relaxed pattern (number + single space + Q/A/THE/BY etc.)
 * 3. Collapsed header detection (pdfdown artifact)
 *
 * @param text - The chunk text (may span multiple transcript lines)
 * @returns LineRange with startLine and endLine, or empty if no line numbers found
 */
export function detectLineNumbers(text: string): LineRange {
  // Strategy 1: Primary pattern (best quality extraction)
  let lineNumbers = extractWithPattern(text, LINE_NUMBER_PATTERN);
  if (lineNumbers.length >= 2) {
    return rangeFromNumbers(lineNumbers);
  }

  // Strategy 2: Relaxed pattern (single space + content starter)
  lineNumbers = extractWithPattern(text, RELAXED_LINE_PATTERN);
  if (lineNumbers.length >= 2) {
    return rangeFromNumbers(lineNumbers);
  }

  // Strategy 3: Collapsed header detection
  // pdfdown sometimes produces "1 2 3 4 5 ... 25" at the start of text
  const collapsedMatch = text.match(COLLAPSED_HEADER_PATTERN);
  if (collapsedMatch) {
    const nums = collapsedMatch[1]
      .trim()
      .split(/\s+/)
      .map((n) => parseInt(n, 10))
      .filter((n) => n >= 1 && n <= 25);
    if (nums.length >= 5) {
      // We know line numbers exist but can't map them to specific text.
      // Try counting non-empty text lines after the header to estimate range.
      const afterHeader = text.slice(collapsedMatch.index! + collapsedMatch[0].length);
      const textLines = afterHeader.split('\n').filter((l) => l.trim().length > 0);
      if (textLines.length > 0) {
        const startLine = nums[0];
        const endLine = Math.min(nums[nums.length - 1], startLine + textLines.length - 1);
        return { startLine, endLine };
      }
      // Fallback: return the full range from the collapsed header
      return { startLine: nums[0], endLine: nums[nums.length - 1] };
    }
  }

  // Strategy 1 may have found a single line number — still return it
  lineNumbers = extractWithPattern(text, LINE_NUMBER_PATTERN);
  if (lineNumbers.length > 0) {
    return rangeFromNumbers(lineNumbers);
  }

  return {};
}

/**
 * Extract line numbers matching a regex pattern from text.
 */
function extractWithPattern(text: string, pattern: RegExp): number[] {
  const lineNumbers: number[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 25) {
      lineNumbers.push(num);
    }
  }

  return lineNumbers;
}

/**
 * Build a LineRange from an array of detected line numbers.
 */
function rangeFromNumbers(lineNumbers: number[]): LineRange {
  lineNumbers.sort((a, b) => a - b);
  return {
    startLine: lineNumbers[0],
    endLine: lineNumbers[lineNumbers.length - 1],
  };
}

/**
 * Check if text appears to be from a Reporter's Record transcript.
 * Heuristic: has numbered lines (1-25 pattern) appearing at least 3 times.
 */
export function isReporterRecordText(text: string): boolean {
  LINE_NUMBER_PATTERN.lastIndex = 0;
  let count = 0;
  while (LINE_NUMBER_PATTERN.exec(text) !== null) {
    count++;
    if (count >= 3) return true;
  }

  // Try relaxed pattern as fallback
  RELAXED_LINE_PATTERN.lastIndex = 0;
  count = 0;
  while (RELAXED_LINE_PATTERN.exec(text) !== null) {
    count++;
    if (count >= 3) return true;
  }

  return false;
}
