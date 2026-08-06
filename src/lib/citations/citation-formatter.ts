/**
 * Extensible citation formatting system.
 *
 * The base `CitationInput` and `CitationFormatter` interface are generic.
 * Concrete formatters (e.g. TexasAppellateCitationFormatter) implement
 * jurisdiction/filing-specific rules.
 *
 * The `getCitationFormatter()` factory selects the correct formatter based on
 * case jurisdiction, state, and filing type — this can be overridden by
 * workflow configuration.
 */

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface CitationInput {
  /** Filing type (e.g. "Reporter's Record", "Clerk's Record", "Motion") */
  filingType?: string;
  /** Volume number for multi-volume filings */
  volumeNumber?: number;
  /** Total distinct volumes for this filing type in the case. When 1, volume number is omitted. */
  totalVolumes?: number;
  /** Case number in appellate format (e.g. "03-25-00333-CV") */
  caseNumber?: string;
  /** Page number within the filing */
  pageNumber: number;
  /** Start line (Reporter's Record transcripts) */
  lineStart?: number;
  /** End line (Reporter's Record transcripts) */
  lineEnd?: number;
  /** Document file name (fallback for generic citations) */
  fileName?: string;
  /** Whether this filing is a supplemental record */
  isSupplemental?: boolean;
  /** Supplemental order (1 = 1st, 2 = 2nd, etc.) */
  supplementalOrder?: number;
}

export interface FormattedCitation {
  /** Full citation string (e.g. "D-1-FM-25-000222 2 CR 140") */
  full: string;
  /** Short citation string (e.g. "2 CR 140") */
  short: string;
  /** Citation type identifier (e.g. "CR", "RR", "generic") */
  type: string;
}

// ---------------------------------------------------------------------------
// Abstract formatter
// ---------------------------------------------------------------------------

export interface CitationFormatter {
  /** Unique identifier for this formatter (e.g. "texas-appellate") */
  id: string;
  /** Human-readable label (e.g. "Texas Appellate") */
  label: string;
  /** Format a full citation */
  format(input: CitationInput): FormattedCitation;
}

// ---------------------------------------------------------------------------
// Texas Appellate formatter
// ---------------------------------------------------------------------------

/** Normalize filing type strings to canonical abbreviations */
function normalizeFilingType(filingType?: string): 'CR' | 'RR' | 'other' {
  if (!filingType) return 'other';
  const ft = filingType.toLowerCase().trim();
  if (ft.includes("clerk's record") || ft === 'cr' || ft.includes('clerk')) return 'CR';
  if (ft.includes("reporter's record") || ft === 'rr' || ft.includes('reporter')) return 'RR';
  return 'other';
}

export class TexasAppellateCitationFormatter implements CitationFormatter {
  id = 'texas-appellate';
  label = 'Texas Appellate';

  format(input: CitationInput): FormattedCitation {
    const kind = normalizeFilingType(input.filingType);
    // Omit volume number when there's only 1 volume for this filing type
    const showVolume = (input.totalVolumes ?? 0) > 1;

    // Build supplemental prefix: "Supp. " or "2nd Supp. " etc.
    let suppPrefix = '';
    if (input.isSupplemental) {
      const order = input.supplementalOrder || 1;
      if (order > 1) {
        const ordinals = ['', '', '2nd', '3rd', '4th', '5th', '6th'];
        suppPrefix = `${ordinals[order] || `${order}th`} Supp. `;
      } else {
        suppPrefix = 'Supp. ';
      }
    }

    switch (kind) {
      case 'CR': {
        const vol = input.volumeNumber ?? 1;
        const typeLabel = `${suppPrefix}CR`;
        const shortCite = showVolume
          ? `${vol} ${typeLabel} ${input.pageNumber}`
          : `${typeLabel} ${input.pageNumber}`;
        const fullCite = input.caseNumber
          ? `${input.caseNumber} ${shortCite}`
          : shortCite;
        return { full: fullCite, short: shortCite, type: suppPrefix ? 'Supp. CR' : 'CR' };
      }

      case 'RR': {
        const vol = input.volumeNumber ?? 1;
        let pagePart = `${input.pageNumber}`;
        if (input.lineStart != null) {
          pagePart += `:${input.lineStart}`;
          if (input.lineEnd != null && input.lineEnd !== input.lineStart) {
            pagePart += `-${input.lineEnd}`;
          }
        }
        const typeLabel = `${suppPrefix}RR`;
        const shortCite = showVolume
          ? `${vol} ${typeLabel} ${pagePart}`
          : `${typeLabel} ${pagePart}`;
        const fullCite = input.caseNumber
          ? `${input.caseNumber} ${shortCite}`
          : shortCite;
        return { full: fullCite, short: shortCite, type: suppPrefix ? 'Supp. RR' : 'RR' };
      }

      default: {
        // Motions, Exhibits, and other filings
        const label = input.filingType || 'Doc';
        const shortCite = showVolume && input.volumeNumber
          ? `${label} Vol. ${input.volumeNumber}, p. ${input.pageNumber}`
          : `${label} p. ${input.pageNumber}`;
        const fullCite = input.caseNumber
          ? `${input.caseNumber} ${shortCite}`
          : shortCite;
        return { full: fullCite, short: shortCite, type: 'generic' };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Generic / fallback formatter
// ---------------------------------------------------------------------------

export class GenericCitationFormatter implements CitationFormatter {
  id = 'generic';
  label = 'Generic';

  format(input: CitationInput): FormattedCitation {
    const doc = input.fileName || input.filingType || 'Document';
    const shortCite = `${doc}, p. ${input.pageNumber}`;
    const fullCite = input.caseNumber
      ? `${input.caseNumber} — ${shortCite}`
      : shortCite;
    return { full: fullCite, short: shortCite, type: 'generic' };
  }
}

// ---------------------------------------------------------------------------
// Formatter registry & factory
// ---------------------------------------------------------------------------

const FORMATTER_REGISTRY: Record<string, CitationFormatter> = {
  'texas-appellate': new TexasAppellateCitationFormatter(),
  generic: new GenericCitationFormatter(),
};

/**
 * Register a custom citation formatter (e.g. loaded from workflow config).
 */
export function registerCitationFormatter(formatter: CitationFormatter): void {
  FORMATTER_REGISTRY[formatter.id] = formatter;
}

/**
 * Get all registered formatter IDs.
 */
export function getAvailableFormatters(): { id: string; label: string }[] {
  return Object.values(FORMATTER_REGISTRY).map(f => ({ id: f.id, label: f.label }));
}

/**
 * Select the appropriate citation formatter based on case metadata.
 *
 * Resolution order:
 * 1. Explicit formatterId override (from workflow config)
 * 2. Jurisdiction + state heuristic
 * 3. Fallback to generic
 */
export function getCitationFormatter(opts?: {
  formatterId?: string;
  jurisdiction?: string;
  state?: string;
  country?: string;
}): CitationFormatter {
  // 1. Explicit override
  if (opts?.formatterId && FORMATTER_REGISTRY[opts.formatterId]) {
    return FORMATTER_REGISTRY[opts.formatterId];
  }

  // 2. Heuristic: Texas state courts → Texas Appellate formatter
  const state = opts?.state?.toLowerCase();
  const country = opts?.country?.toLowerCase();
  if (
    state === 'texas' || state === 'tx' ||
    opts?.jurisdiction?.toLowerCase().includes('texas')
  ) {
    return FORMATTER_REGISTRY['texas-appellate'];
  }

  // 3. Default — US state courts get generic, international gets generic
  if (country === 'united states' || country === 'us' || !country) {
    return FORMATTER_REGISTRY['generic'];
  }

  return FORMATTER_REGISTRY['generic'];
}

// ---------------------------------------------------------------------------
// Convenience helpers (backward-compatible with plan)
// ---------------------------------------------------------------------------

export function formatTexasCitation(input: CitationInput): string {
  return new TexasAppellateCitationFormatter().format(input).full;
}

export function formatCitationShort(input: CitationInput): string {
  return new TexasAppellateCitationFormatter().format(input).short;
}
