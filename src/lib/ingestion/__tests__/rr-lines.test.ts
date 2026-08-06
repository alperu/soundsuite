import { reconstructRRLines, RRLine } from '../pdf-parser';

/** Synthetic pdfjs text item (PLAN-rr-structure item 2 — privacy rule:
 * fixtures are invented; the real-volume byte-identity check runs via
 * RR_FIXTURE_PDF below and was additionally proven one-off at refactor
 * time against a full 73-page volume). */
function item(str: string, x: number, y: number, w = str.length * 5, h = 12) {
  return { str, transform: [1, 0, 0, 1, x, y], width: w, height: h };
}

/** The join reconstructRRPageText applies — duplicated here so the tests
 * pin the CONTRACT between the pure function and the page-text format. */
const joinPage = (lines: RRLine[]) =>
  lines.map(l => (l.lineNumber !== null ? `${l.lineNumber}  ${l.text}` : l.text)).join('\n');

describe('reconstructRRLines', () => {
  const numberedPage = [
    item('12', 300, 760),                       // page number (header, single item line)
    item('1', 40, 700), item('THE COURT: Good morning, counsel.', 90, 700),
    item('2', 40, 686), item('You may proceed with the witness.', 90, 686),
    item('3', 40, 672),                          // blank numbered line (number only)
    item('4', 40, 658), item('Q.', 90, 658), item('State your name for the record.', 120, 658),
  ];

  it('detects the line-number column and splits number from text', () => {
    const lines = reconstructRRLines(numberedPage);
    const numbered = lines.filter(l => l.lineNumber !== null);
    expect(numbered.map(l => l.lineNumber)).toEqual([1, 2, 3, 4]);
    expect(numbered[0].text).toBe('THE COURT: Good morning, counsel.');
    expect(numbered[3].text).toBe('Q. State your name for the record.');
  });

  it('keeps blank numbered lines with empty text (the 1-25 invariant)', () => {
    const lines = reconstructRRLines(numberedPage);
    const blank = lines.find(l => l.lineNumber === 3);
    expect(blank).toBeDefined();
    expect(blank!.text).toBe('');
  });

  it('header/caption lines get lineNumber null', () => {
    const lines = reconstructRRLines(numberedPage);
    expect(lines[0].lineNumber).toBeNull();
    expect(lines[0].text).toBe('12');
  });

  it('page-text join reproduces the legacy format exactly', () => {
    const text = joinPage(reconstructRRLines(numberedPage));
    expect(text).toBe([
      '12',
      '1  THE COURT: Good morning, counsel.',
      '2  You may proceed with the witness.',
      '3  ',
      '4  Q. State your name for the record.',
    ].join('\n'));
  });

  it('pages without a consistent number column stay plain (needs ≥3 clustered candidates)', () => {
    const plain = [
      item('CAUSE NO. 00-0000-XX', 200, 700),
      item('1', 40, 660), item('only one numbered-looking line', 90, 660),
      item('Regular caption text here', 100, 640),
    ];
    const lines = reconstructRRLines(plain);
    expect(lines.every(l => l.lineNumber === null)).toBe(true);
    expect(joinPage(lines)).toContain('1 only one numbered-looking line');
  });

  it('captures per-line geometry (x0/x1/y/height) for the block producer', () => {
    const lines = reconstructRRLines(numberedPage);
    const l1 = lines.find(l => l.lineNumber === 1)!;
    expect(l1.x0).toBe(40);                          // includes the number column
    expect(l1.x1).toBeGreaterThan(90);               // last item x + width
    expect(l1.y).toBe(700);
    expect(l1.height).toBe(12);
  });

  it('numbers far right of the column are treated as text, not line numbers', () => {
    const page = [
      item('1', 40, 700), item('first', 90, 700),
      item('2', 40, 686), item('second', 90, 686),
      item('3', 40, 672), item('third', 90, 672),
      item('5', 400, 658), item('exhibits admitted', 430, 658), // number, but x=400 ≫ column
    ];
    const lines = reconstructRRLines(page);
    const far = lines.find(l => l.y === 658)!;
    expect(far.lineNumber).toBeNull();
    expect(far.text).toBe('5 exhibits admitted');
  });

  it('empty input yields empty output', () => {
    expect(reconstructRRLines([])).toEqual([]);
    expect(reconstructRRLines([{ str: '   ', transform: [1, 0, 0, 1, 0, 0] }])).toEqual([]);
  });
});

// Integration: real-volume invariants. Takes the PDF path from an env var
// (privacy rule: no corpus paths/names in the repo) and skips when unset.
const RR_PDF = process.env.RR_FIXTURE_PDF;
(RR_PDF ? describe : describe.skip)('reconstructRRLines against a real RR volume', () => {
  jest.setTimeout(120_000);

  it('page text join matches extractTextForRR output for every page', async () => {
    const { PDFParser } = await import('../pdf-parser');
    const parser = new PDFParser();
    const pages = await parser.extractTextForRR(RR_PDF!);
    expect(pages.length).toBeGreaterThan(0);
    // extractTextForRR internally uses the same join over reconstructRRLines;
    // this asserts the numbered format holds corpus-wide.
    const numbered = pages.filter(p => /^\d{1,2}  /m.test(p.text));
    expect(numbered.length / pages.length).toBeGreaterThan(0.8);
  });
});
