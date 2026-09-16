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

  describe('run-together ratio (regression: one long token must not zero a page)', () => {
    const PROSE =
      'The Court considered the motion and the response of the parties and finds that the relief ' +
      'requested should be granted in part. Defendant shall produce the documents described in the ' +
      'request within fourteen days of the date of this order. All other relief is denied. ';

    it('passes a normal page containing one long URL', () => {
      const text = `${PROSE} Filed electronically at https://efile.txcourts.gov/CaseManagement/Filing/Details/123456789 on the date below. ${PROSE}`;
      expect(assessOcrOutput(text).ok).toBe(true);
    });

    it('passes a page with a long email address and a filename', () => {
      const text = `${PROSE} Service copy sent to appellate.clerk.thirddistrict@txcourts.gov attaching Response_to_Motion_Final_Version.pdf as required. ${PROSE}`;
      expect(assessOcrOutput(text).ok).toBe(true);
    });

    it('passes prose with a single concatenated-cell artifact (below ratio)', () => {
      const text = `${PROSE} TotalAmountDueUnderThePromissoryNoteAsOfTheDateOfJudgment was disputed. ${PROSE}${PROSE}`;
      expect(assessOcrOutput(text).ok).toBe(true);
    });

    it('still rejects a page dominated by run-together text', () => {
      const run = 'thepartiesagreedthatthepropertyshallbesoldandtheproceedsdividedequallybetweenthemafterpaymentofallliens';
      const text = `${run} ${run} ${run} short tail`;
      const result = assessOcrOutput(text);
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('run-together-text');
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

describe('salvaging an output that degenerated into a repetition loop', () => {
  // 856 of 1,578 real rejections were pure 'repetition-loop', and discarding
  // them lost pages that were mostly correct — one was 32,467 characters
  // beginning "Schedule E (Form 1040) 2022" with accurate attachment numbers
  // and figures before the tail started repeating.
  const GOOD = [
    'SCHEDULE E (Form 1040) 2022  Supplemental Income and Loss',
    'Attachment Sequence No. 13   Name shown on return: A. PARTY',
    'Part I  Income or Loss From Rental Real Estate and Royalties',
    '1a Physical address of each property: 100 Example Street, Suite 4',
    '2  For each rental real estate property listed above, report the',
    '   number of fair rental and personal use days.',
    '3  Rents received ......................... 24,000',
    '4  Royalties received ...................... 1,150',
    '5  Advertising ............................... 320',
    '6  Auto and travel ........................... 890',
    '7  Cleaning and maintenance ................ 1,470',
    '8  Commissions ............................... 610',
  ].join('\n');
  const LOOP = Array.from({ length: 60 }, () => 'Page 1 of 2 Page 1 of 2 Page 1 of 2').join('\n');

  it('keeps the good prefix and drops the loop', () => {
    const assessment = assessOcrOutput(`${GOOD}\n${LOOP}`);

    expect(assessment.ok).toBe(false);
    expect(assessment.reasons).toEqual(['repetition-loop']);
    expect(assessment.salvagedText).toBeDefined();
    // The substance survives…
    expect(assessment.salvagedText).toContain('SCHEDULE E');
    expect(assessment.salvagedText).toContain('Rents received');
    // …and the garbage does not.
    expect(assessment.salvagedText).not.toContain('Page 1 of 2 Page 1 of 2');
  });

  it('returns text the gate itself accepts — the safety property', () => {
    const { salvagedText } = assessOcrOutput(`${GOOD}\n${LOOP}`);
    expect(salvagedText).toBeDefined();
    // Whatever is salvaged must pass every check on its own, or the salvage
    // would be a hole in the gate rather than a use of it.
    expect(assessOcrOutput(salvagedText!).ok).toBe(true);
  });

  it('salvages NOTHING when the loop starts immediately', () => {
    // The dangerous case. isRepetitionLoop is inoperative below 240 chars, so
    // a naive "longest passing prefix" search would happily return ~239
    // characters of pure garbage. MIN_SALVAGE_CHARS exists for this.
    const assessment = assessOcrOutput(LOOP);
    expect(assessment.ok).toBe(false);
    expect(assessment.salvagedText).toBeUndefined();
  });

  it('refuses to salvage when something else is also wrong', () => {
    // 88 real cases were 'repetition-loop' + 'unexpected-script'. An output
    // that is also CJK soup was never trustworthy, so no prefix of it is.
    // CJK must DOMINATE for 'unexpected-script' to fire (a stray stamp glyph
    // on an English page is meant to pass), so the loop here is CJK too.
    const cjkLoop = Array.from({ length: 60 }, () => '欽定四庫全書 欽定四庫全書 欽定四庫全書').join('\n');
    const assessment = assessOcrOutput(`${GOOD}\n${cjkLoop}`);
    expect(assessment.reasons).toContain('repetition-loop');
    expect(assessment.reasons).toContain('unexpected-script');
    expect(assessment.salvagedText).toBeUndefined();
  });

  it('leaves a clean output completely alone', () => {
    const assessment = assessOcrOutput(GOOD);
    expect(assessment.ok).toBe(true);
    expect(assessment.salvagedText).toBeUndefined();
  });

  it('does not attempt single-line output', () => {
    // The cut is line-based on purpose: "the last line that said something
    // new" is a meaning the code can defend, and there is no equivalent
    // inside one unbroken line. Declining is the honest outcome — the page
    // stays 'ocr-quality-rejected' and therefore still repairable.
    const oneLine = `${GOOD.replace(/\n/g, ' ')} ${'Page 1 of 2 '.repeat(200)}`;
    const assessment = assessOcrOutput(oneLine);
    expect(assessment.salvagedText).toBeUndefined();
  });

  it('keeps only the good text, not as much loop as the detector tolerates', () => {
    // Regression on the first implementation, which searched for the longest
    // prefix that still passed the gate: on this exact input it returned
    // 2,571 characters — the 663 good ones plus ~53 lines of garbage, since
    // line-uniqueness only trips at 13/(12+N) < 0.2.
    const { salvagedText } = assessOcrOutput(`${GOOD}\n${LOOP}`);
    expect(salvagedText).toBeDefined();
    expect(salvagedText!.length).toBeLessThanOrEqual(GOOD.length + 40);
    expect(salvagedText).not.toContain('Page 1 of 2');
  });
});
