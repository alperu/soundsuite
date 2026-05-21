/**
 * Build a unified display label for a Filing from its structured properties.
 *
 * Format: `[Supp N] Title [Vol N]`
 *   - "Supp" prefix only when `isSupplemental === true`.
 *   - The trailing number after "Supp" is omitted when supplementalOrder is 1
 *     or unset (a 1st supplemental is just "Supp").
 *   - "Vol N" suffix only when `volumeNumber` is set.
 *
 * Both header (filing detail page) and the sidebar filings list use this
 * helper so the same filing renders identically everywhere.
 */
export interface FilingLabelInput {
  title: string;
  volumeNumber?: number | null;
  isSupplemental?: boolean | null;
  supplementalOrder?: number | null;
}

export function formatFilingLabel(filing: FilingLabelInput): string {
  const parts: string[] = [];
  if (filing.isSupplemental) {
    const n = filing.supplementalOrder && filing.supplementalOrder > 1
      ? ` ${filing.supplementalOrder}`
      : '';
    parts.push(`Supp${n}`);
  }
  parts.push(filing.title);
  if (filing.volumeNumber != null) {
    parts.push(`Vol ${filing.volumeNumber}`);
  }
  return parts.join(' ');
}
