/** @jest-environment node */

import { heuristicDecompose } from '../heuristic-decompose';

describe('heuristicDecompose', () => {
  it('always includes the query as written first', () => {
    const q = 'what obligations did the parties agree to regarding the shared property';
    const r = heuristicDecompose(q);
    expect(r.subQueries[0]).toBe(q);
    expect(r.intent).toBe(q);
  });

  it('produces 2–4 de-duplicated keyword variants for a prose question', () => {
    const r = heuristicDecompose('what obligations did the parties agree to regarding the shared property, and when was the deadline for repairs');
    expect(r.subQueries.length).toBeGreaterThanOrEqual(2);
    expect(r.subQueries.length).toBeLessThanOrEqual(4);
    const lower = r.subQueries.map((s) => s.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    // Stopword-stripped variant keeps the content words.
    expect(lower.some((s) => s.includes('obligations') && s.includes('shared property') && !s.startsWith('what'))).toBe(true);
    // Phrase chunk after "and" surfaces on its own.
    expect(lower.some((s) => s.includes('deadline') && !s.includes('obligations'))).toBe(true);
  });

  it('caps every sub-query at 20 words', () => {
    const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
    const r = heuristicDecompose(long);
    for (const s of r.subQueries) expect(s.split(' ').length).toBeLessThanOrEqual(20);
  });

  it('splits boolean chip queries on OR branches without an LLM', () => {
    const r = heuristicDecompose('{{scheduling order}} or {{continuance}}');
    expect(r.subQueries).toEqual(['{{scheduling and order}}', '{{continuance}}']); // same astSerialize form deep-search emits
  });

  it('does not boolean-parse plain prose containing "and"/"or"', () => {
    const r = heuristicDecompose('motion to compel and sanctions');
    expect(r.subQueries[0]).toBe('motion to compel and sanctions');
  });

  it('handles a short or empty query without throwing', () => {
    expect(heuristicDecompose('hearing').subQueries).toEqual(['hearing']);
    expect(heuristicDecompose('   ').subQueries).toEqual(['   ']);
  });
});
