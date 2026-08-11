import {
  createPreambleSplitter,
  findReportStart,
  hasEchoEvidence,
  splitReportPreamble,
} from '../report-preamble';

// All fixtures are synthetic: invented parties, placeholder cause numbers,
// generic filing names.
const ECHOED_CONTEXT = [
  'ontinued from the prior page.',
  'The witness confirmed the delivery date.',
  '',
  '---',
  '[00-0000-XX — motion.pdf, p. 12]',
  '[Case: Sample Matter | Filing: Motion]',
  '',
  '12',
  '1  Q. And you signed it?',
  '2  A. I did.',
  '',
  '---',
  '[00-0000-XX — exhibit.pdf, p. 4]',
  '[Case: Sample Matter | Filing: Exhibit]',
  '',
  'Attached hereto as Exhibit A.',
].join('\n');

const PLANNING = [
  '## Instructions',
  'Generate a comprehensive research report answering the research question.',
  '',
  '## Report Structure',
  '',
  'The user wants to know when the agreement was signed. Let me collect the leads:',
  '1. The deposition excerpt.',
  '2. The exhibit.',
].join('\n');

const REPORT = [
  '# Research Report: Signing Date of the Agreement',
  '',
  '## 1. Summary',
  '',
  'The record shows the agreement was signed [00-0000-XX CR 12].',
  '',
  '## 3. Gaps',
  '',
  'The original is not in evidence.',
].join('\n');

describe('report preamble detection', () => {
  it('treats a clean report as all answer', () => {
    const clean = '## Summary\n\nThe motion was granted [00-0000-XX CR 4].\n\n## Findings\n\nMore.';
    expect(hasEchoEvidence(clean)).toBe(false);
    expect(splitReportPreamble(clean)).toEqual({ thoughts: '', report: clean });
  });

  it('does not divert a report that opens with prose instead of a heading', () => {
    const prose = 'The short answer is yes. Below is the supporting analysis.\n\n## Findings\n\nDetail.';
    expect(splitReportPreamble(prose)).toEqual({ thoughts: '', report: prose });
  });

  it('recognizes standalone bracketed citation lines as echoed context', () => {
    expect(hasEchoEvidence(ECHOED_CONTEXT)).toBe(true);
  });

  it('does not treat inline bracket citations as an echo', () => {
    const inline = 'The court held otherwise [00-0000-XX CR 12], and later [00-0000-XX CR 88] reversed.';
    expect(hasEchoEvidence(inline)).toBe(false);
  });

  it('ignores prompt-scaffolding headings when locating the report start', () => {
    const text = `${PLANNING}\n\n${REPORT}`;
    expect(findReportStart(text)).toBe(text.indexOf('# Research Report:'));
  });
});

describe('splitReportPreamble', () => {
  const garbled = `${ECHOED_CONTEXT}\n\n${PLANNING}\n\n${REPORT}`;

  it('splits echoed context and planning off the front of the report', () => {
    const { thoughts, report } = splitReportPreamble(garbled);
    expect(report).toBe(REPORT);
    expect(thoughts).toContain('[Case: Sample Matter | Filing: Motion]');
    expect(thoughts).toContain('## Report Structure');
    expect(thoughts).not.toContain('# Research Report:');
  });

  it('yields an empty report when the model never wrote one', () => {
    const { thoughts, report } = splitReportPreamble(`${ECHOED_CONTEXT}\n\n${PLANNING}`);
    expect(report).toBe('');
    expect(thoughts).toContain('## Instructions');
  });

  it('finds a report that starts at "## Summary" with no title above it', () => {
    const text = `${ECHOED_CONTEXT}\n\n## Summary\n\nThe agreement was signed.`;
    expect(splitReportPreamble(text).report).toBe('## Summary\n\nThe agreement was signed.');
  });
});

describe('createPreambleSplitter (streaming)', () => {
  /** Feed text through the splitter in chunks of `size`. */
  function run(text: string, size: number) {
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const splitter = createPreambleSplitter({
      onToken: t => tokens.push(t),
      onThoughts: t => thoughts.push(t),
    });
    for (let i = 0; i < text.length; i += size) splitter.push(text.slice(i, i + size));
    const final = splitter.finish();
    return { emittedReport: tokens.join(''), emittedThoughts: thoughts.join(''), final };
  }

  const garbled = `${ECHOED_CONTEXT}\n\n${PLANNING}\n\n${REPORT}`;

  it.each([1, 7, 60, 5000])('routes report and thoughts correctly at chunk size %i', size => {
    const { emittedReport, emittedThoughts, final } = run(garbled, size);
    expect(emittedReport).toBe(REPORT);
    expect(final.report).toBe(REPORT);
    // No excerpt text may reach the answer channel.
    expect(emittedReport).not.toContain('[Case: Sample Matter');
    expect(emittedThoughts).toContain('[Case: Sample Matter | Filing: Motion]');
    // The accumulated copy is trimmed at the split; the streamed copy keeps the
    // trailing whitespace it had already emitted.
    expect(final.thoughts).toBe(emittedThoughts.trimEnd());
  });

  it.each([1, 13, 5000])('passes a clean report straight through at chunk size %i', size => {
    const clean = '## Summary\n\nThe motion was granted [00-0000-XX CR 4].\n\nMore prose follows here.';
    const { emittedReport, emittedThoughts } = run(clean, size);
    expect(emittedReport).toBe(clean);
    expect(emittedThoughts).toBe('');
  });

  it('flushes short outputs that never reach the scan window', () => {
    const short = 'No results found.';
    const { emittedReport, emittedThoughts } = run(short, 1000);
    expect(emittedReport).toBe(short);
    expect(emittedThoughts).toBe('');
  });

  it('sends everything to thoughts when no report heading ever arrives', () => {
    const { emittedReport, emittedThoughts } = run(`${ECHOED_CONTEXT}\n\n${PLANNING}`, 11);
    expect(emittedReport).toBe('');
    expect(emittedThoughts).toContain('## Instructions');
  });
});
