/**
 * OTSL table-markup normalizer.
 *
 * PaddleOCR-VL's `Table Recognition:` task emits OTSL cell tokens, not HTML
 * (measured 2026-08-06 on real financial exhibits — PLAN-ss-docparse §0.1
 * Phase 0):
 *
 *   <fcel>Transaction Date<fcel>Description<fcel>Amount<nl>
 *   <fcel>2023-11-01<fcel>Payment received<lcel><nl>
 *
 * Tokens: <fcel> starts a cell (content follows until the next token),
 * <lcel> extends the previous cell one column (colspan), <ecel> is an empty
 * cell, <nl> ends the row. This module converts OTSL into the three forms
 * the pipeline needs: HTML (metadata `table_html`), markdown (synthesis
 * context), and normalized cell text (embedded chunk text — §6.2 decision 5).
 */

export interface OtslCell {
  text: string;
  colspan: number;
}

export interface OtslTable {
  rows: OtslCell[][];
  cellCount: number;
}

const OTSL_TOKEN_RE = /<(fcel|lcel|ecel|nl)>/g;

/** Number of OTSL tokens in a string — cheap "is this OTSL?" probe. */
export function countOtslTokens(raw: string): number {
  return (raw.match(OTSL_TOKEN_RE) || []).length;
}

/**
 * Parse OTSL markup into rows of cells. Returns null when the input does not
 * look like OTSL (fewer than 4 cell tokens) — callers fall back to treating
 * the output as text/HTML.
 */
export function parseOtsl(raw: string): OtslTable | null {
  const parts = raw.split(OTSL_TOKEN_RE);
  // split with capture group yields [pre, token, content, token, content, …]
  let cellTokens = 0;
  const rows: OtslCell[][] = [];
  let row: OtslCell[] = [];

  for (let i = 1; i < parts.length; i += 2) {
    const token = parts[i];
    const content = (parts[i + 1] ?? '').trim();
    switch (token) {
      case 'fcel':
        cellTokens++;
        row.push({ text: content, colspan: 1 });
        break;
      case 'lcel':
        cellTokens++;
        if (row.length > 0) row[row.length - 1].colspan++;
        else row.push({ text: content, colspan: 1 });
        break;
      case 'ecel':
        cellTokens++;
        row.push({ text: content, colspan: 1 });
        break;
      case 'nl':
        rows.push(row);
        row = [];
        // content after <nl> (rare) belongs to no cell; drop it
        break;
    }
  }
  if (row.length > 0) rows.push(row);

  if (cellTokens < 4) return null;
  return { rows: rows.filter(r => r.length > 0), cellCount: cellTokens };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function otslToHtml(table: OtslTable): string {
  const body = table.rows
    .map((row, ri) => {
      const tag = ri === 0 ? 'th' : 'td';
      const cells = row
        .map(c => `<${tag}${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}>${escapeHtml(c.text)}</${tag}>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table>${body}</table>`;
}

/** Markdown pipe table. Colspans are flattened (repeated empty cells) —
 * markdown has no colspan; the HTML form is authoritative for structure. */
export function otslToMarkdown(table: OtslTable): string {
  const expand = (row: OtslCell[]) =>
    row.flatMap(c => [c.text.replace(/\|/g, '\\|'), ...Array(c.colspan - 1).fill('')]);
  const width = Math.max(...table.rows.map(r => expand(r).length));
  const line = (cells: string[]) => `| ${[...cells, ...Array(Math.max(0, width - cells.length)).fill('')].join(' | ')} |`;
  const [header, ...rest] = table.rows;
  const out = [line(expand(header ?? [])), `|${Array(width).fill(' --- ').join('|')}|`];
  for (const r of rest) out.push(line(expand(r)));
  return out.join('\n');
}

/** Normalized cell text for EMBEDDING (§6.2 decision 5): cells joined by
 * ` | `, rows by newline. No markup tokens — the vector encodes content. */
export function otslToCellText(table: OtslTable): string {
  return table.rows
    .map(row => row.map(c => c.text).filter(t => t.length > 0).join(' | '))
    .filter(l => l.length > 0)
    .join('\n');
}

export interface NormalizedTable {
  format: 'otsl' | 'html' | 'markdown' | 'text';
  /** Authoritative structure — always present for otsl/html inputs. */
  html?: string;
  markdown?: string;
  /** What goes into embedded chunk text. Always present. */
  cellText: string;
  rowCount: number;
}

/**
 * Normalize any `Table Recognition:` output (OTSL, HTML, markdown pipes, or
 * plain text) into the storage/embedding forms.
 */
export function normalizeTableOutput(raw: string): NormalizedTable {
  const t = raw.trim();
  const otsl = parseOtsl(t);
  if (otsl) {
    return {
      format: 'otsl',
      html: otslToHtml(otsl),
      markdown: otslToMarkdown(otsl),
      cellText: otslToCellText(otsl),
      rowCount: otsl.rows.length,
    };
  }
  if (/<table[\s>]/i.test(t)) {
    const cellText = t
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map(l => l.replace(/\s*\|\s*$/, '').trim())
      .filter(Boolean)
      .join('\n');
    return { format: 'html', html: t, cellText, rowCount: (t.match(/<tr[\s>]/gi) || []).length };
  }
  const pipeLines = t.split('\n').filter(l => (l.match(/\|/g) || []).length >= 2);
  if (pipeLines.length >= 2) {
    const cellText = pipeLines
      .filter(l => !/^\s*\|?[\s\-|:]+\|?\s*$/.test(l)) // drop separator rows
      .map(l => l.replace(/^\s*\|\s*|\s*\|\s*$/g, '').split(/\s*\|\s*/).join(' | '))
      .join('\n');
    return { format: 'markdown', markdown: t, cellText, rowCount: pipeLines.length };
  }
  return { format: 'text', cellText: t, rowCount: 0 };
}
