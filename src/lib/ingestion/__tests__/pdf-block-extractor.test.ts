import {
  buildBlocks,
  groupIntoLines,
  modalFontSize,
  detectTableRegions,
  looksLikeTranscriptPage,
  PositionedItem,
} from '../pdf-block-extractor';

const PAGE = { width: 612, height: 792 }; // US Letter, points

/** One text run. y is BOTTOM-left origin (pdfjs convention). */
function run(str: string, x: number, y: number, opts: { w?: number; h?: number; font?: string } = {}): PositionedItem {
  return { str, x, y, width: opts.w ?? str.length * 5, height: opts.h ?? 11, fontName: opts.font ?? 'Times-Roman' };
}

/** A body paragraph: consecutive lines 14pt apart. */
function paragraph(lines: string[], x: number, yTop: number): PositionedItem[] {
  return lines.map((l, i) => run(l, x, yTop - i * 14));
}

describe('pdf-block-extractor pure core', () => {
  it('groups items into x-sorted lines top-to-bottom', () => {
    const items = [run('world', 200, 700), run('hello', 100, 700), run('below', 100, 650)];
    const lines = groupIntoLines(items);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('hello world');
    expect(lines[1].text).toBe('below');
  });

  it('detects headings by font size and bold', () => {
    const items = [
      run('ORDERS ABOUT CONDUCT', 150, 700, { h: 16, font: 'Times-Bold' }),
      ...paragraph(['All parties are ordered to refrain from the conduct', 'described in the following subsections of this order.'], 72, 670),
    ];
    const blocks = buildBlocks(items, PAGE);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].text).toBe('ORDERS ABOUT CONDUCT');
    expect(blocks[1].type).toBe('paragraph');
    expect(blocks[1].text).toContain('refrain from the conduct');
  });

  it('splits paragraphs on large vertical gaps', () => {
    const items = [
      ...paragraph(['First paragraph line one.', 'First paragraph line two.'], 72, 700),
      ...paragraph(['Second paragraph after a gap.'], 72, 600),
    ];
    const blocks = buildBlocks(items, PAGE);
    const paras = blocks.filter(b => b.type === 'paragraph');
    expect(paras).toHaveLength(2);
  });

  it('classifies furniture bands and captures Bates identifiers', () => {
    const items = [
      run('Case 1:24-cv-00123 Filed 06/12/26', 100, 780),  // top 7% band
      ...paragraph(['Body content of the page goes here.'], 72, 500),
      run('DEF-004512', 480, 20),                            // bottom band, Bates
      run('Page 12 of 38', 260, 30),
    ];
    const blocks = buildBlocks(items, PAGE);
    const header = blocks.find(b => b.type === 'page_header');
    expect(header?.text).toContain('Filed');
    const pageNum = blocks.find(b => b.type === 'page_number');
    expect(pageNum?.text).toBe('Page 12 of 38');
    const footer = blocks.find(b => b.type === 'page_footer');
    expect(footer?.identifiers?.batesNumber).toBe('DEF-004512');
  });

  it('detects an aligned borderless table as a table block', () => {
    const rows = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01'];
    const items: PositionedItem[] = [
      // narrative context so median gap reflects prose
      ...paragraph(['The following payments were made by the respondent', 'during the relevant period of the proceedings below.'], 72, 720),
      run('Date', 72, 680), run('Description', 220, 680), run('Amount', 420, 680),
      ...rows.flatMap((d, i) => [
        run(d, 72, 660 - i * 14),
        run('Mortgage payment', 220, 660 - i * 14),
        run(`$${1450 + i}.00`, 420, 660 - i * 14),
      ]),
    ];
    const blocks = buildBlocks(items, PAGE);
    const table = blocks.find(b => b.type === 'table');
    expect(table).toBeDefined();
    expect(table!.text).toContain('Mortgage payment');
    expect(table!.bbox).not.toBeNull();
    // the narrative did not get swallowed into the table
    expect(blocks.find(b => b.type === 'paragraph')?.text).toContain('respondent');
  });

  it('transcript pages produce ZERO blocks (§6.1 full carve-out → legacy line-aware path)', () => {
    // 20 numbered lines with speaker-indent structure (RR signature)
    const items: PositionedItem[] = [];
    for (let i = 1; i <= 20; i++) {
      items.push(run(String(i), 40, 720 - i * 14));
      items.push(run('THE COURT:', 90, 720 - i * 14));
      items.push(run('Please proceed with the witness.', 200, 720 - i * 14));
    }
    const lines = groupIntoLines(items);
    expect(looksLikeTranscriptPage(lines)).toBe(true);
    // No blocks at all: the page must delegate to the legacy chunker so
    // startLine/endLine detection over chunk text stays byte-identical.
    expect(buildBlocks(items, PAGE)).toHaveLength(0);
  });

  it('detects numbered ALL-CAPS headings at body size (real-filing gap)', () => {
    const items = [
      // centered-ish, uppercase, same size as body, not bold
      run('I. NATURE OF THE EMERGENCY', 194, 700),
      ...paragraph(['This is an accelerated interlocutory appeal from an order', 'appointing a receiver over the appellant’s homestead.'], 72, 670),
    ];
    const blocks = buildBlocks(items, PAGE);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].text).toBe('I. NATURE OF THE EMERGENCY');
    expect(blocks[1].type).toBe('paragraph');
  });

  it('does NOT classify numbered body list items as headings', () => {
    const items = [
      ...paragraph(['WHEREFORE, PREMISES CONSIDERED, Movant prays that the Court:'], 72, 700),
      run('1. Set this motion for hearing at the earliest possible date;', 90, 660),
      run('2. Enter an order expunging the notice in its entirety; and', 90, 630),
      run('3. Grant such other and further relief to which Movant is entitled.', 90, 600),
    ];
    const blocks = buildBlocks(items, PAGE);
    expect(blocks.filter(b => b.type === 'heading')).toHaveLength(0);
  });

  it('modal font size reflects body text, not headings', () => {
    const items = [
      run('BIG HEADING', 150, 700, { h: 18 }),
      ...paragraph(['body body body body body body body body', 'more body text at the standard size here'], 72, 660),
    ];
    expect(modalFontSize(groupIntoLines(items))).toBe(11);
  });

  it('detectTableRegions requires shared columns across consecutive lines', () => {
    // 3 lines with segments at unrelated x positions — NOT a table
    const items = [
      ...[0, 1, 2].flatMap(i => [
        run('a', 72 + i * 37, 600 - i * 14),
        run('b', 250 + i * 61, 600 - i * 14),
        run('c', 430 + i * 23, 600 - i * 14),
      ]),
    ];
    // include prose to establish a normal median gap
    const all = [...paragraph(['some regular prose line to set the gap baseline'], 72, 700), ...items];
    const lines = groupIntoLines(all);
    const regions = detectTableRegions(lines);
    expect(regions).toHaveLength(0);
  });
});
