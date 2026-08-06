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

  it('double-spaced pleading lines merge into one paragraph; indent starts a new one', () => {
    // 32pt leading at 14pt-ish type — the measured real-filing shape that
    // used to split EVERY line into its own paragraph block.
    const long = (s: string) => run(s, 72, 0, { w: 440, h: 14 });
    const items: PositionedItem[] = [
      { ...long('The Receivership Order routes the net proceeds to counsel as'), y: 700 },
      { ...long('trustee, and Petitioner maintains that her concealed proceeds'), y: 668 },
      { ...run('are held and managed by an attorney abroad.', 72, 636, { w: 300, h: 14 }) }, // ragged last line
      { ...run('On June 23, 2026, counsel disclosed that attorney to be a', 108, 604, { w: 404, h: 14 }) }, // indented ¶ start
      { ...long('specialist in data-privacy law who relied on its difficulty'), y: 572 },
      { ...run('to keep the proceeds hidden from the court.', 72, 540, { w: 280, h: 14 }) }, // ragged ¶ end
      // second indent start to give x0=108 cluster membership (≥2 lines)
      { ...run('As the Declaration shows, it is a legal impossibility under', 108, 508, { w: 404, h: 14 }) },
      { ...long('Turkish law for an attorney to hold and manage such funds.'), y: 476 },
    ];
    const blocks = buildBlocks(items, PAGE);
    const paras = blocks.filter(b => b.type === 'paragraph');
    expect(paras).toHaveLength(3); // was 8 one-line "paragraphs" before the fix
    expect(paras[0].text).toContain('Receivership Order');
    expect(paras[0].text).toContain('abroad');
    expect(paras[1].text).toContain('June 23, 2026');
    expect(paras[2].text).toContain('legal impossibility');
  });

  it('single-spaced centered caption does not shatter the double-spaced body (page-1 regression)', () => {
    // Measured on page 1 of a real motion: the centered caption block is
    // single-spaced (16pt leading at 14pt type) and TIED the body's 32pt
    // leading 8-vs-8 in the lead histogram; the old smaller-lead tie-break
    // made modalLead=16, so all nine body lines became one-line paragraphs.
    const centered = (s: string, y: number) =>
      run(s, 306 - s.length * 2.5, y, { w: s.length * 5, h: 14 });
    const body = (s: string, y: number, x = 72) => run(s, x, y, { w: 612 - x - 72, h: 14 });
    const items: PositionedItem[] = [
      // caption: 8 centered lines, 16pt leading
      centered('IN THE COURT OF APPEALS', 707),
      centered('FOR THE THIRD JUDICIAL DISTRICT', 691),
      centered('SITTING AT THE CAPITAL', 675),
      centered('IN RE THE MARRIAGE OF', 659),
      centered('PETITIONER AND RESPONDENT', 643),
      centered('EMERGENCY MOTION TO STAY', 627),
      centered('AND FOR OTHER RELIEF', 611),
      centered('FILED UNDER RULE 29.3', 595),
      // body: indented ¶ start, then 8 full-width lines, 32pt leading
      body('Petitioner respectfully moves this Court for an emergency', 549, 108),
      body('stay of the sale ordered below, and in support shows the', 517),
      body('following facts and authorities, each established by the', 485),
      body('record and the attached declarations of the parties and', 453),
      body('counsel, which demonstrate that the ordered sale would', 421),
      body('irreparably moot the pending appeal before this Court can', 389),
      body('reach the merits of the underlying receivership dispute', 357),
      body('and the associated turnover orders entered by the trial', 325),
      run('court in aid of its judgment enforcement jurisdiction.', 72, 293, { w: 300, h: 14 }), // ragged ¶ end
      // second x0=108 line so the indent cluster has ≥2 members
      body('A separate indented paragraph begins here with facts that', 261, 108),
      body('continue at the margin on the following line as usual.', 229),
    ];
    const blocks = buildBlocks(items, PAGE);
    const paras = blocks.filter(b => b.type === 'paragraph');
    // The nine-line body run must be ONE paragraph (plus the second indented
    // one) — NOT nine one-line blocks.
    const bigBody = paras.find(p => p.text.includes('respectfully moves'));
    expect(bigBody).toBeDefined();
    expect(bigBody!.text).toContain('enforcement jurisdiction');
    const separate = paras.find(p => p.text.includes('separate indented paragraph'));
    expect(separate).toBeDefined();
    expect(separate).not.toBe(bigBody);
    // No shatter: every paragraph containing body prose spans multiple lines
    expect(bigBody!.text.split('\n').length).toBe(9);
  });

  describe('singleton first-line indent (page-8 defect, tesseract-model rule)', () => {
    // Body at x0=72, double-spaced 32pt leading, 14pt type. The opener at
    // x0=108 is the ONLY indented line on the page — the ≥2-member cluster
    // gate cannot see it; the margin-anchored singleton rule must.
    const body = (s: string, y: number, x = 72, w = 468) => run(s, x, y, { w, h: 14 });

    it('splits at a right-edge-anchored singleton indent after a ragged line', () => {
      const items: PositionedItem[] = [
        body('First paragraph opens with facts that continue across the', 700),
        body('full width of the page and then conclude here shortly.', 668, 72, 300), // ragged, ends '.'
        body('The second paragraph begins with an indented opener that', 636, 108, 432), // x1=540
        body('returns to the margin for its continuation lines below.', 604),
      ];
      const paras = buildBlocks(items, PAGE).filter(b => b.type === 'paragraph');
      expect(paras).toHaveLength(2);
      expect(paras[0].text).toContain('conclude here');
      expect(paras[1].text).toContain('indented opener');
    });

    it('splits at a ragged singleton indent when the NEXT line returns to the margin', () => {
      const items: PositionedItem[] = [
        body('The preceding paragraph reaches its natural conclusion in', 700),
        body('a short final line here.', 668, 72, 160), // ragged, ends '.'
        body('Next paragraph opens short.', 636, 108, 250), // ragged opener, x1=358 (not centered)
        body('and the following line returns to the left margin again,', 604),
        body('continuing the paragraph across the full page width now.', 572),
      ];
      const paras = buildBlocks(items, PAGE).filter(b => b.type === 'paragraph');
      expect(paras).toHaveLength(2);
      expect(paras[1].text).toContain('opens short');
      expect(paras[1].text).toContain('full page width');
    });

    it('does NOT fire on a 72pt block-quote inset (INDENT_MAX bound)', () => {
      const items: PositionedItem[] = [
        body('The witness statement includes the following passage from', 700),
        body('the underlying record below.', 668, 72, 180), // ragged, ends '.'
        body('A single quoted line inset by a full inch appears here.', 636, 144, 300),
        body('After the quotation the paragraph resumes at the margin', 604),
        body('and continues to the end of the page without a new break.', 572),
      ];
      const paras = buildBlocks(items, PAGE).filter(b => b.type === 'paragraph');
      // dx=72 exceeds INDENT_MAX(49): the singleton rule must not fire, and
      // the inset line stays merged (no cluster peer either).
      expect(paras).toHaveLength(1);
    });

    it('does NOT fire on a signature-block offset under uniform leading', () => {
      const items: PositionedItem[] = [
        body('The relief requested herein is warranted for the reasons', 700),
        body('stated above and in the record.', 668, 72, 210), // ragged, ends '.'
        body('Respectfully submitted', 636, 306, 160), // sig offset, dx=234
      ];
      const paras = buildBlocks(items, PAGE).filter(b => b.type === 'paragraph');
      expect(paras).toHaveLength(1);
    });

    it('does NOT split mid-run when consecutive lines share the indent', () => {
      const items: PositionedItem[] = [
        body('The court considered each of the following enumerated items', 700),
        body('in the order presented.', 668, 72, 150), // ragged, ends '.'
        body('First indented item of the run.', 636, 108, 250),
        body('Second indented item of the run.', 604, 108, 250),
        body('Third indented item of the run.', 572, 108, 250),
      ];
      const blocks = buildBlocks(items, PAGE).filter(b => b.type === 'paragraph');
      // The run may split from the margin paragraph (cluster rule — existing
      // behavior), but the three indented lines must stay ONE block.
      const runBlock = blocks.find(b => b.text.includes('First indented'));
      expect(runBlock).toBeDefined();
      expect(runBlock!.text).toContain('Third indented');
    });
  });

  it('full-width ALL-CAPS document title becomes ONE heading, not part of the body (page-1 title)', () => {
    // Real page-1 shape: two near-full-width caps title lines (opaque font,
    // so the bold heuristic is blind), then a caps salutation ending ':',
    // then double-spaced prose. The title must come out as a single heading;
    // the salutation must NOT (terminated caps).
    const items: PositionedItem[] = [
      run('MOVANT’S EMERGENCY MOTION TO STAY TRIAL COURT', 95, 700, { w: 422, h: 14 }),
      run('ORDER AND ENJOIN SALE OF REAL PROPERTY PENDING APPEAL', 79, 684, { w: 454, h: 14 }),
      run('TO THE HONORABLE COURT OF APPEALS:', 72, 652, { w: 300, h: 14 }),
      run('Movant respectfully shows the Court the following facts and', 72, 620, { w: 468, h: 14 }),
      run('authorities in support of the emergency relief requested.', 72, 588, { w: 468, h: 14 }),
      run('The record establishes each element required for a stay of', 72, 556, { w: 468, h: 14 }),
      run('the underlying order pending resolution of this appeal.', 72, 524, { w: 468, h: 14 }),
    ];
    const blocks = buildBlocks(items, PAGE);
    const headings = blocks.filter(b => b.type === 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].text).toBe(
      'MOVANT’S EMERGENCY MOTION TO STAY TRIAL COURT ORDER AND ENJOIN SALE OF REAL PROPERTY PENDING APPEAL');
    const paras = blocks.filter(b => b.type === 'paragraph');
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toContain('HONORABLE');
    expect(paras[0].text).toContain('pending resolution');
  });

  it('heading mid-flow on a double-spaced page still splits out (absorption regression)', () => {
    // Uniform 32pt leading: no gap ever exceeds 1.4×lead, so only the
    // heading-like signal can break the paragraph before the heading line.
    const long = (s: string, y: number) => run(s, 72, y, { w: 440, h: 14 });
    const items: PositionedItem[] = [
      long('The trial court expunged the notice on a Wednesday, and', 700),
      long('signed the order the following week without a hearing set.', 668),
      run('III. THE OFFSHORE DESTINATION', 190, 636, { w: 232, h: 14 }), // centered, caps, numbered
      long('When the concealment was exposed with public land records,', 604),
      long('the petitioner changed course and moved for sanctions there.', 572),
    ];
    const blocks = buildBlocks(items, PAGE);
    const heading = blocks.find(b => b.type === 'heading');
    expect(heading).toBeDefined();
    expect(heading!.text).toBe('III. THE OFFSHORE DESTINATION');
    const paras = blocks.filter(b => b.type === 'paragraph');
    expect(paras).toHaveLength(2);
    expect(paras[0].text).toContain('expunged');
    expect(paras[1].text).toContain('changed course');
  });

  it('wrapped heading continuation merges into the heading block (page-12 shape)', () => {
    const long = (s: string, y: number) => run(s, 72, y, { w: 440, h: 14 });
    const items: PositionedItem[] = [
      // heading wraps: first line unterminated, continuation starts lowercase,
      // both at NORMAL 32pt body leading (the real measured shape)
      run('C. The sale is a concealed transaction that cannot yield', 130, 700, { w: 352, h: 14 }),
      run('fair value.', 130, 668, { w: 80, h: 14 }),
      long('The agent marketing the property is, on information and', 636),
      long('belief, associated with the petitioner in the proceeding.', 604),
    ];
    const blocks = buildBlocks(items, PAGE);
    const heading = blocks.find(b => b.type === 'heading');
    expect(heading).toBeDefined();
    expect(heading!.text).toBe('C. The sale is a concealed transaction that cannot yield fair value.');
    const paras = blocks.filter(b => b.type === 'paragraph');
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toContain('agent marketing');
    expect(paras[0].text).not.toContain('fair value');
  });

  it('ALL-CAPS heading wrap merges (short caps continuation of caps heading)', () => {
    const long = (s: string, y: number) => run(s, 72, y, { w: 440, h: 14 });
    const items: PositionedItem[] = [
      long('The trial court expunged the notice recently filed, and', 700),
      long('signed the order the following week without any hearing.', 668),
      run('III. THE OFFSHORE DESTINATION AND THE FOREIGN', 130, 636, { w: 352, h: 14 }),
      run('RETALIATION', 270, 604, { w: 90, h: 14 }),
      long('The order routes the net proceeds to opposing counsel as', 572),
    ];
    const blocks = buildBlocks(items, PAGE);
    const heading = blocks.find(b => b.type === 'heading')!;
    expect(heading.text).toBe('III. THE OFFSHORE DESTINATION AND THE FOREIGN RETALIATION');
    const paras = blocks.filter(b => b.type === 'paragraph');
    expect(paras[paras.length - 1].text).toContain('net proceeds');
    expect(paras.every(p => !p.text.includes('RETALIATION'))).toBe(true);
  });

  it('terminated heading followed by uppercase body does NOT merge', () => {
    const items: PositionedItem[] = [
      run('D. Appellant raises substantial questions on the merits.', 130, 700, { w: 360, h: 14 }),
      run('The trial court erred in several respects described below,', 72, 668, { w: 440, h: 14 }),
      run('each of which independently supports reversal on appeal.', 72, 636, { w: 440, h: 14 }),
    ];
    const blocks = buildBlocks(items, PAGE);
    const heading = blocks.find(b => b.type === 'heading')!;
    expect(heading.text).toBe('D. Appellant raises substantial questions on the merits.');
    expect(blocks.filter(b => b.type === 'paragraph')).toHaveLength(1);
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
