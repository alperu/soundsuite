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
        'CAUSE NO. D-1-FM-21-005611 IN THE MATTER OF THE MARRIAGE OF EKIM STEVENS IN THE DISTRICT COURT OF TRAVIS COUNTY, TEXAS 261ST JUDICIAL DISTRICT NOTICE: THIS DOCUMENT CONTAINS SENSITIVE DATA',
      ],
      [
        'table-like content with repeated cells',
        Array.from({ length: 20 }, (_, i) => `| ${i + 1} | Mortgage payment | $${1450 + i} | cleared |`).join('\n'),
      ],
      [
        'page with a couple of stray CJK stamp glyphs',
        'This certified copy of the decree was filed with the district clerk of Travis County 印 on the date shown, and the parties were served pursuant to the rules of civil procedure.',
      ],
    ])('%s', (_label, text) => {
      const result = assessOcrOutput(text);
      expect(result.ok).toBe(true);
      expect(result.reasons).toEqual([]);
    });
  });
});
