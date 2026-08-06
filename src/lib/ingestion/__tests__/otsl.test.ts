import { parseOtsl, otslToHtml, otslToMarkdown, otslToCellText, normalizeTableOutput, countOtslTokens } from '../otsl';

// Shape measured from the live model (Phase 0, 2026-08-06)
const MEASURED =
  '<fcel>Transaction Date<fcel>Description<fcel>Amount<nl>' +
  '<fcel>2023-11-01<fcel>Payment received<fcel>$120.00<nl>' +
  '<fcel>2023-11-15<fcel>Purchase — Macy\'s<fcel>$45.10<nl>' +
  '<fcel>Total<lcel><fcel>$165.10<nl>';

describe('OTSL normalizer', () => {
  it('parses the measured output shape', () => {
    const t = parseOtsl(MEASURED)!;
    expect(t).not.toBeNull();
    expect(t.rows).toHaveLength(4);
    expect(t.rows[0].map(c => c.text)).toEqual(['Transaction Date', 'Description', 'Amount']);
    // <lcel> extends "Total" to colspan 2
    expect(t.rows[3][0]).toEqual({ text: 'Total', colspan: 2 });
    expect(t.rows[3][1].text).toBe('$165.10');
  });

  it('renders HTML with header row and colspans, escaped', () => {
    const html = otslToHtml(parseOtsl(MEASURED)!);
    expect(html).toContain('<th>Transaction Date</th>');
    expect(html).toContain('<td colspan="2">Total</td>');
    expect(html.startsWith('<table>')).toBe(true);
    expect(html.endsWith('</table>')).toBe(true);
    const escaped = otslToHtml(parseOtsl('<fcel>a<b<fcel>x<fcel>y<fcel>z<nl>')!);
    expect(escaped).toContain('a&lt;b');
  });

  it('renders markdown with separator and flattened colspans', () => {
    const md = otslToMarkdown(parseOtsl(MEASURED)!);
    const lines = md.split('\n');
    expect(lines[0]).toBe('| Transaction Date | Description | Amount |');
    expect(lines[1]).toMatch(/^\|( --- \|){3}$/);
    expect(lines[4]).toBe('| Total |  | $165.10 |');
  });

  it('cell text is markup-free and embedding-ready', () => {
    const cellText = otslToCellText(parseOtsl(MEASURED)!);
    expect(cellText).toContain('2023-11-01 | Payment received | $120.00');
    expect(cellText).not.toMatch(/[<>]/);
  });

  it('rejects non-OTSL input', () => {
    expect(parseOtsl('just some prose about payments')).toBeNull();
    expect(parseOtsl('<fcel>only<nl>')).toBeNull(); // < 4 cell tokens
    expect(countOtslTokens('no tokens here')).toBe(0);
  });

  describe('normalizeTableOutput', () => {
    it('otsl → all three forms', () => {
      const n = normalizeTableOutput(MEASURED);
      expect(n.format).toBe('otsl');
      expect(n.html).toContain('<table>');
      expect(n.markdown).toContain('| Transaction Date |');
      expect(n.cellText).toContain('$120.00');
      expect(n.rowCount).toBe(4);
    });

    it('html passthrough with derived cell text', () => {
      const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
      const n = normalizeTableOutput(html);
      expect(n.format).toBe('html');
      expect(n.html).toBe(html);
      expect(n.cellText).toBe('A | B\n1 | 2');
    });

    it('markdown passthrough, separator rows dropped from cell text', () => {
      const md = '| A | B |\n|---|---|\n| 1 | 2 |';
      const n = normalizeTableOutput(md);
      expect(n.format).toBe('markdown');
      expect(n.cellText).toBe('A | B\n1 | 2');
    });

    it('plain text fallback', () => {
      const n = normalizeTableOutput('no table here at all');
      expect(n.format).toBe('text');
      expect(n.html).toBeUndefined();
    });
  });
});
