/**
 * Regex patterns for extracting Person/Persona candidates from legal-doc text.
 *
 * Used by Stage 2 of `extract.ts`. Patterns are intentionally permissive — the
 * dedup pass downstream rejects false positives by matching against existing
 * Person rows. False negatives (missing a name) are worse than false positives.
 */

/** Bar number — captures optional jurisdiction prefix + 6-9 digit number. */
export const BAR_NUMBER_RE =
  /\b(?:State\s+Bar\s+(?:No|#)?[.:\s]+|SBN\s*:?\s*|Bar\s+No[.:\s]+)?(TX-?|CA-?|NY-?|FL-?|US-?)?(\d{6,9})\b/g

/** Caption: PLAINTIFF vs DEFENDANT on a single uppercase line. */
export const CAPTION_RE =
  /^([A-Z][A-Z\s,.\-']{2,})\s+(?:vs?\.?|v\.)\s+([A-Z][A-Z\s,.\-']{2,})$/m

/** `/s/ <Name>` electronic signature marker. */
export const E_SIG_RE = /\/s\/\s+([A-Z][A-Za-z.\-'\s]{2,60})/g

/** `By: <Name>` block-lead. */
export const BY_LINE_RE = /^\s*By:\s+([A-Z][A-Za-z.\-'\s]{2,60})\s*$/m

/** Judge honorific (mixed case). */
export const HON_JUDGE_RE =
  /Hon(?:orable)?\.?\s+(?:Judge\s+)?([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+){1,3})/g

/** All-caps judge caption. */
export const ALLCAPS_JUDGE_RE = /\bJUDGE\s+([A-Z][A-Z.\-]+(?:\s+[A-Z][A-Z.\-]+){0,3})\b/g

/** Clerk file-stamp. */
export const CLERK_RE =
  /Clerk\s+of\s+(?:the\s+)?Court[:\s]+([A-Z][A-Za-z.\-,]+(?:\s+[A-Z][A-Za-z.\-,]+){0,3})/g

/** Filed by clerk. */
export const FILED_BY_RE =
  /Filed\s+by[:\s]+([A-Z][A-Za-z.\-,]+(?:\s+[A-Z][A-Za-z.\-,]+){0,3})/g

/** Certified Shorthand Reporter number. */
export const CSR_RE = /CSR\s+(?:No|#)?[.\s:]*(\d{3,7})/g

/** Court reporter explicit. */
export const COURT_REPORTER_RE =
  /Court\s+Reporter[:\s]+([A-Z][A-Za-z.\-,]+(?:\s+[A-Z][A-Za-z.\-,]+){0,3})/g

/** Email. */
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** "Attorney for <Plaintiff|Defendant|Movant|Respondent>" signature-block context. */
export const ATTORNEY_FOR_RE =
  /Attorney\s+for\s+(?:the\s+)?(Plaintiff|Defendant|Movant|Respondent|Petitioner|Appellant|Appellee|Intervenor)s?/i

/** Tokenise a name into normalised lowercase tokens. */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z\s.\-']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

/** Normalise a name for comparison (strip punctuation, collapse whitespace). */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s.\-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
