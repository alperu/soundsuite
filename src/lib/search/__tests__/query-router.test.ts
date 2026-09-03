import { classifyQueryComplexity, routeToResearchMode } from '../query-router';
import { segmentChipsAndIntents } from '../chip-segments';

describe('classifyQueryComplexity', () => {
  describe('deep-report — report / memo / summary deliverables', () => {
    const reportQueries = [
      'write a memo on the discovery disputes',
      'summarize the arguments in the motion to compel',
      'draft a brief overview of the custody filings',
      'give me a report on the receivership motion',
      'prepare a write-up of the sanctions hearing',
      'summary of every affidavit filed in April',
    ];
    it.each(reportQueries)('routes %j to deep-report', (q) => {
      const d = classifyQueryComplexity(q);
      expect(d.route).toBe('deep-report');
      expect(d.confidence).toBeGreaterThanOrEqual(0.8);
    });
    it('wins over RLM language when a deliverable is requested', () => {
      expect(classifyQueryComplexity('write a memo tracing how the trust dispute evolved over time').route).toBe('deep-report');
    });
    it('wins over deep language when a deliverable is requested', () => {
      expect(classifyQueryComplexity('summarize and compare the two motions to disqualify').route).toBe('deep-report');
    });
  });

  describe('rlm — synthesis / relationship / evolution', () => {
    const rlmQueries = [
      'trace how the trust dispute evolved across every filing',
      'how did the custody arrangement change over time',
      'connect the relationship between the receivership motion and the gag order',
      'walk me through the chronology of the bill of review',
      'piece together what happened with the trust funds',
    ];
    it.each(rlmQueries)('routes %j to rlm', (q) => {
      const d = classifyQueryComplexity(q);
      expect(d.route).toBe('rlm');
      expect(d.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('deep — comparison / breadth / multi-faceted', () => {
    const deepQueries = [
      'compare the two motions to disqualify',
      'every motion filed in April 2026',
      'across all filings, what does opposing counsel claim about assets',
      'where do the affidavits contradict each other',
      'list all orders signed by the judge', // "all orders" → breadth
    ];
    it.each(deepQueries)('routes %j to deep', (q) => {
      expect(classifyQueryComplexity(q).route).toBe('deep');
    });
  });

  describe('single-shot — exact identifiers, quoted phrases, short factual', () => {
    it('routes a cause number to single-shot', () => {
      const d = classifyQueryComplexity('petition for cause 03-25-00333-CV');
      expect(d.route).toBe('single-shot');
      expect(d.confidence).toBeGreaterThan(0.8);
    });
    it('routes a D-style cause number to single-shot', () => {
      expect(classifyQueryComplexity('docs for D-1-FM-21-000111').route).toBe('single-shot');
    });
    it('routes a quoted phrase to single-shot', () => {
      expect(classifyQueryComplexity('find "motion to compel"').route).toBe('single-shot');
    });
    it('routes a short factual question to single-shot', () => {
      expect(classifyQueryComplexity('what is the cause number on the petition?').route).toBe('single-shot');
      expect(classifyQueryComplexity('who is the assigned judge').route).toBe('single-shot');
    });
  });

  describe('chip awareness', () => {
    it('routes a chip-only query with minimal intent to single-shot', () => {
      const q = '{{ case==@04a8cd94-359c-4feb-be16-979592c3c235 }}';
      const d = classifyQueryComplexity(q, segmentChipsAndIntents(q));
      expect(d.route).toBe('single-shot');
    });
    it('still escalates a chip query with synthesis intent to rlm', () => {
      const q = '{{ case==@04a8cd94-359c-4feb-be16-979592c3c235 }} trace how the trust evolved over time';
      const d = classifyQueryComplexity(q, segmentChipsAndIntents(q));
      expect(d.route).toBe('rlm');
    });
  });

  describe('default — safe middle', () => {
    it('falls back to deep when no strong signal', () => {
      const d = classifyQueryComplexity('the defendant financial situation and disclosed assets');
      expect(d.route).toBe('deep');
      expect(d.confidence).toBeLessThan(0.5);
    });
    it('handles empty query without throwing', () => {
      expect(classifyQueryComplexity('').route).toBe('single-shot');
      expect(classifyQueryComplexity('   ').route).toBe('single-shot');
    });
  });

  it('always returns a known route + bounded confidence', () => {
    for (const q of ['', 'a', 'compare X and Y', 'trace it', '"x"', '03-25-00333-CV']) {
      const d = classifyQueryComplexity(q);
      expect(['no-retrieval', 'single-shot', 'deep', 'deep-report', 'rlm']).toContain(d.route);
      expect(d.confidence).toBeGreaterThanOrEqual(0);
      expect(d.confidence).toBeLessThanOrEqual(1);
      expect(typeof d.reason).toBe('string');
    }
  });
});

describe('routeToResearchMode', () => {
  it('maps every router tier onto a research tier', () => {
    expect(routeToResearchMode('single-shot')).toBe('fast');
    expect(routeToResearchMode('no-retrieval')).toBe('fast');
    expect(routeToResearchMode('deep')).toBe('deep');
    expect(routeToResearchMode('deep-report')).toBe('deep-report');
    expect(routeToResearchMode('rlm')).toBe('deep-rlm');
  });
});
