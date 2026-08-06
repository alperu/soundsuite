/**
 * Zero-delta golden test — PLAN-rr-structure item 10 (THE GATE).
 *
 * A Reporter's Record run through the docparse-enabled path (structureOnly
 * pages carrying RR blocks → StructuredChunker) must produce a chunk array
 * IDENTICAL (text + metadata) to the legacy path (same pages, no blocks →
 * inner chunker directly). This is the byte-identity guarantee that lets
 * transcripts have structure AND line numbers together.
 *
 * Includes the risk case from the plan: caption/certificate pages under the
 * 15-margin-number threshold (no line-number column) mixed with transcript
 * pages — the gate must be document-level, not per-page.
 *
 * All fixtures are synthetic.
 */
import { StructuredChunker } from '../structured-chunker';
import { TextChunker, type PageText as ChunkerPageText } from '../text-chunker';
import { produceStructuredPages } from '../structure-producer';
import type { PageText } from '../pdf-parser';
import type { RRLine } from '../pdf-parser';

function num(lineNumber: number, text: string, idx: number): RRLine {
  return { lineNumber, text, x0: 72, x1: 540, y: 720 - idx * 26, height: 12 };
}
function plain(text: string, y: number): RRLine {
  return { lineNumber: null, text, x0: 72, x1: 300, y, height: 10 };
}

/** Synthetic 4-page RR volume: caption page (no number column), two
 * transcript pages, certificate page. */
function makeVolume(): PageText[] {
  const captionLines = [
    plain('REPORTER’S RECORD', 720),
    plain('VOLUME 2 OF 3', 700),
    plain('CAUSE NO. 00-0000-XX', 660),
    plain('IN THE DISTRICT COURT', 640),
  ];
  const p2Lines = [
    plain('12', 760),
    ...[
      'PROCEEDINGS',
      'THE COURT: We are on the record in',
      'cause number 00-0000-XX.',
      'MR. DOE: Ready, Your Honor.',
      'MS. ROE: Ready.',
      'THE COURT: Call your first witness.',
      '',
      'JANE WITNESS,',
      'having been first duly sworn, testified:',
      'Q.  Please state your name.',
      'A.  Jane Witness.',
      'Q.  Where do you live?',
      'A.  In Travis County.',
    ].map((t, i) => num(i + 1, t, i)),
  ];
  const p3Lines = [
    plain('13', 760),
    ...[
      'Q.  Did you sign the agreement?',
      'A.  Yes, I did.',
      'MR. DOE: Objection, leading.',
      'THE COURT: Sustained.',
      'Q.  What happened next?',
      'A.  We left the office.',
    ].map((t, i) => num(i + 1, t, i)),
  ];
  const certLines = [
    plain('CERTIFICATE', 720),
    plain('I certify this is a true record.', 690),
    plain('Sam Reporter, CSR', 660),
  ];

  const join = (lines: RRLine[]) =>
    lines.map(l => (l.lineNumber !== null ? `${l.lineNumber}  ${l.text}` : l.text)).join('\n');

  return [captionLines, p2Lines, p3Lines, certLines].map((rrLines, i) => {
    const text = join(rrLines);
    return { pageNumber: i + 1, text, textDensity: text.trim().length, rrLines, pageHeight: 792 };
  });
}

const SAC = {
  caseName: 'Doe v. Roe',
  filingType: "Reporter's Record",
  documentSummary: 'A synthetic transcript volume for the zero-delta gate.',
};

describe('RR zero-delta gate (item 10)', () => {
  it('docparse-on chunks are identical to legacy chunks for an RR document', async () => {
    // Legacy path: plain pages, inner chunker directly.
    const legacyPages = makeVolume();
    const inner1 = new TextChunker({ chunkSize: 64, overlapSize: 8, tokenizer: 'simple' });
    const legacyChunks = await inner1.chunkPages(
      legacyPages as unknown as ChunkerPageText[], 'doc-1', 'case-1', SAC);

    // Docparse path: structure stage (transcriptDoc) then StructuredChunker.
    const structuredPages = makeVolume();
    const counters = await produceStructuredPages({
      filePath: '/vol2.pdf',
      pages: structuredPages,
      ocrThreshold: 50,
      ocrEngine: null,
      transcriptDoc: true,
    });
    // Sanity: structure really was produced (this is not a vacuous pass).
    expect(counters.rrPages).toBe(4);
    expect(structuredPages.every(p => p.structureOnly)).toBe(true);
    expect(structuredPages[1].blocks!.some(b => b.speaker === 'THE COURT')).toBe(true);

    const inner2 = new TextChunker({ chunkSize: 64, overlapSize: 8, tokenizer: 'simple' });
    const structuredChunks = await new StructuredChunker(inner2).chunkPages(
      structuredPages as unknown as ChunkerPageText[], 'doc-1', 'case-1', SAC);

    // THE GATE: full deep equality — text AND metadata (incl. chunkIndex).
    expect(structuredChunks).toEqual(legacyChunks);
    expect(structuredChunks.length).toBeGreaterThan(0);

    inner1.dispose();
    inner2.dispose();
  });

  it('page text is unchanged by the structure stage (mutation check)', async () => {
    const before = makeVolume().map(p => p.text);
    const pages = makeVolume();
    await produceStructuredPages({
      filePath: '/vol2.pdf', pages, ocrThreshold: 50, ocrEngine: null, transcriptDoc: true,
    });
    expect(pages.map(p => p.text)).toEqual(before);
  });
});
