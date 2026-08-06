import { assessOcrOutput } from '../ocr-quality-gate';

const FOX = 'The quick brown fox jumps over the lazy dog.';

describe('assessOcrOutput', () => {
  describe('rejects observed garbage classes', () => {
    it.each([
      ['pangram loop with newlines', (FOX + '\n\n').repeat(50), 'repetition-loop'],
      ['pangram loop without newlines', (FOX + ' ').repeat(50), 'repetition-loop'],
      ['url segment loop', 'e.com/' + 'en/'.repeat(200), 'repetition-loop'],
      [
        'templated repetition with varying numbers',
        Array.from({ length: 60 }, (_, i) => `Page ${2 * i + 1} of ${2 * i + 2}`).join(' '),
        'repetition-loop',
      ],
      ['CJK on an English corpus', '欽定四庫全書', 'unexpected-script'],
      ['CJK pair', '三 五', 'unexpected-script'],
      [
        'LaTeX recitation',
        'p2 usd100 is the value of \\( \\sin(\\theta) = \\frac{3}{5} \\), so the cosine value is positive. In order to find the area of a circle with radius r.',
        'latex-hallucination',
      ],
      [
        'letter soup',
        'ZQBLK HORANILAYPAVLCASRS MRVBLKT QQZPWX BNMKLO WERTYU PLKHGF ZXCVBM ASDFGH QWERTZ',
        'letter-soup',
      ],
      [
        'run-together text',
        'fourteenthdayaftertheoriginalpetitionisfiledthisOrdershallcontinueinfullforceandeffectasatemporaryinjunction until further order',
        'run-together-text',
      ],
    ])('%s', (_label, text, expectedReason) => {
      const result = assessOcrOutput(text);
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain(expectedReason);
    });
  });

  describe('table task profile', () => {
    const VALID_TABLE =
      '<table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>' +
      Array.from({ length: 20 }, (_, i) =>
        `<tr><td>2024-0${(i % 9) + 1}-01</td><td>Payment</td><td>$${1200 + i}.00</td></tr>`).join('') +
      '</table>';

    it('passes valid HTML tables that the text profile would reject', () => {
      // Sanity: the text profile DOES reject this (repetitive markup)
      expect(assessOcrOutput(VALID_TABLE).ok).toBe(false);
      // The table profile passes it
      const r = assessOcrOutput(VALID_TABLE, { task: 'table' });
      expect(r.ok).toBe(true);
      expect(r.reasons).toEqual([]);
    });

    it('passes OTSL cell markup (what PaddleOCR-VL actually emits — Phase 0 finding)', () => {
      const otsl = '<fcel>Transaction Date<fcel>Description<fcel>Amount<nl>' +
        Array.from({ length: 12 }, (_, i) => `<fcel>2023-11-0${(i % 9) + 1}<fcel>Payment received<fcel>$${120 + i}.00<nl>`).join('') +
        '<fcel>Total<lcel><fcel>$1,545.00<nl>';
      const r = assessOcrOutput(otsl, { task: 'table' });
      expect(r.ok).toBe(true);
      expect(r.reasons).toEqual([]);
    });

    it('rejects OTSL ending mid-token as truncated', () => {
      const truncated = '<fcel>Date<fcel>Amount<nl><fcel>2023-11-01<fcel>$120<nl><fcel>2023-11-02<fce';
      const r = assessOcrOutput(truncated, { task: 'table' });
      expect(r.ok).toBe(false);
      expect(r.reasons).toContain('table-truncated');
    });

    it('passes markdown pipe tables', () => {
      const md = '| Date | Description | Amount |\n|---|---|---|\n' +
        Array.from({ length: 10 }, (_, i) => `| 2024-01-0${i} | Payment | $${100 + i} |`).join('\n');
      expect(assessOcrOutput(md, { task: 'table' }).ok).toBe(true);
    });

    it.each([
      ['empty table', '<table></table>', 'table-empty'],
      ['truncated table (no close, mid-tag)', '<table><tr><td>Jan</td><td>$100</td></tr><tr><td>Feb</td><td', 'table-truncated'],
      ['prose instead of a table', 'This page contains a discussion of the mortgage payments made by the respondent over several months during the case.', 'table-empty'],
      ['CJK hallucination on a crop', '欽定四庫全書 三五 丁二', 'unexpected-script'],
    ])('%s → %s', (_label, text, expectedReason) => {
      const r = assessOcrOutput(text, { task: 'table' });
      expect(r.ok).toBe(false);
      expect(r.reasons).toContain(expectedReason);
    });

    it('seal task: short outputs pass, repetition check disabled', () => {
      expect(assessOcrOutput('DISTRICT COURT OF TRAVIS COUNTY TEXAS', { task: 'seal' }).ok).toBe(true);
    });
  });

  describe('passes legitimate content', () => {
    it.each([
      ['empty output', ''],
      ['short caption', FOX],
      [
        'normal legal prose',
        Array.from({ length: 30 }, (_, i) =>
          `Paragraph ${i}: the respondent filed a distinct motion regarding docket entry ${i * 13} before the court.`).join('\n'),
      ],
      [
        'caption block with case number and ALL CAPS',
        'CAUSE NO. D-0-XX-00-000000 IN THE MATTER OF THE MARRIAGE OF JANE DOE IN THE DISTRICT COURT OF EXAMPLE COUNTY, TEXAS 000TH JUDICIAL DISTRICT NOTICE: THIS DOCUMENT CONTAINS SENSITIVE DATA',
      ],
      [
        'table-like content with repeated cells',
        Array.from({ length: 20 }, (_, i) => `| ${i + 1} | Mortgage payment | $${1450 + i} | cleared |`).join('\n'),
      ],
      [
        'page with a couple of stray CJK stamp glyphs',
        'This certified copy of the decree was filed with the district clerk of the county 印 on the date shown, and the parties were served pursuant to the rules of civil procedure.',
      ],
    ])('%s', (_label, text) => {
      const result = assessOcrOutput(text);
      expect(result.ok).toBe(true);
      expect(result.reasons).toEqual([]);
    });
  });
});
