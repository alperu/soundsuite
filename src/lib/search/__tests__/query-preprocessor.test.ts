import { QueryPreprocessor } from '../query-preprocessor';

describe('QueryPreprocessor', () => {
  describe('process()', () => {
    it('should extract keywords from "Where did Milner say there is no fraud?"', () => {
      const result = QueryPreprocessor.process('Where did Milner say there is no fraud?');

      expect(result.original).toBe('Where did Milner say there is no fraud?');
      expect(result.keywords).toContain('no');
      expect(result.keywords).toContain('fraud');
      // Milner ends up as entity + keyword
      expect(result.keywords).toContain('milner');
      // Stopwords removed
      expect(result.keywords).not.toContain('where');
      expect(result.keywords).not.toContain('did');
      expect(result.keywords).not.toContain('say');
      expect(result.keywords).not.toContain('there');
      expect(result.keywords).not.toContain('is');
    });

    it('should detect Milner as an entity', () => {
      const result = QueryPreprocessor.process('Where did Milner say there is no fraud?');
      expect(result.entities).toContain('Milner');
    });

    it('should detect fraud as a legal term', () => {
      const result = QueryPreprocessor.process('Where did Milner say there is no fraud?');
      expect(result.legalTerms).toContain('fraud');
    });

    it('should generate query variants with entity + legal term pairs', () => {
      const result = QueryPreprocessor.process('Where did Milner say there is no fraud?');
      expect(result.queryVariants.length).toBeGreaterThan(0);
      // Should include a variant with Milner + fraud
      expect(result.queryVariants.some(v =>
        v.toLowerCase().includes('milner') && v.toLowerCase().includes('fraud')
      )).toBe(true);
    });
  });

  describe('keyword extraction', () => {
    it('should keep negation words', () => {
      const result = QueryPreprocessor.process('There is not any evidence of negligence');
      expect(result.keywords).toContain('not');
      expect(result.keywords).toContain('negligence');
    });

    it('should remove question stopwords', () => {
      const result = QueryPreprocessor.process('What was the ruling on the motion?');
      expect(result.keywords).not.toContain('what');
      expect(result.keywords).not.toContain('was');
      expect(result.keywords).not.toContain('the');
      expect(result.keywords).toContain('ruling');
      expect(result.keywords).toContain('motion');
    });

    it('should deduplicate keywords', () => {
      const result = QueryPreprocessor.process('fraud and more fraud evidence');
      const fraudCount = result.keywords.filter(k => k === 'fraud').length;
      expect(fraudCount).toBe(1);
    });
  });

  describe('entity detection', () => {
    it('should detect capitalized non-first words as entities', () => {
      const result = QueryPreprocessor.process('What did Johnson testify about?');
      expect(result.entities).toContain('Johnson');
    });

    it('should detect entities after title prefixes', () => {
      const result = QueryPreprocessor.process('Dr. Smith testified about the injury');
      expect(result.entities).toContain('Smith');
    });

    it('should not detect common words as entities', () => {
      const result = QueryPreprocessor.process('The Court ruled on the State motion');
      expect(result.entities).not.toContain('Court');
      expect(result.entities).not.toContain('State');
    });

    it('should detect multiple entities', () => {
      const result = QueryPreprocessor.process('Did Baker agree with Thompson about the contract?');
      expect(result.entities).toContain('Baker');
      expect(result.entities).toContain('Thompson');
    });
  });

  describe('legal term recognition', () => {
    it('should detect single-word legal terms', () => {
      const result = QueryPreprocessor.process('evidence of negligence and breach of duty');
      expect(result.legalTerms).toContain('negligence');
      expect(result.legalTerms).toContain('breach');
      expect(result.legalTerms).toContain('evidence');
      expect(result.legalTerms).toContain('duty');
    });

    it('should detect multi-word legal terms', () => {
      const result = QueryPreprocessor.process('Was there a summary judgment filed?');
      expect(result.legalTerms).toContain('summary judgment');
    });

    it('should detect terms case-insensitively', () => {
      const result = QueryPreprocessor.process('FRAUD was alleged in the complaint');
      expect(result.legalTerms).toContain('fraud');
      expect(result.legalTerms).toContain('complaint');
    });
  });

  describe('page reference parsing', () => {
    it('should parse "2 RR page 17"', () => {
      const result = QueryPreprocessor.process('Look at 2 RR page 17 for testimony');
      expect(result.pageReferences).toEqual({
        volume: 2,
        filingType: "Reporter's Record",
        page: 17,
      });
    });

    it('should parse "2 RR 17:24"', () => {
      const result = QueryPreprocessor.process('See 2 RR 17:24');
      expect(result.pageReferences).toEqual({
        volume: 2,
        filingType: "Reporter's Record",
        page: 17,
        lineStart: 24,
      });
    });

    it('should parse "CR page 15"', () => {
      const result = QueryPreprocessor.process('Filed in CR page 15');
      expect(result.pageReferences).toEqual({
        filingType: "Clerk's Record",
        page: 15,
      });
    });

    it('should parse "Vol. 3 page 42"', () => {
      const result = QueryPreprocessor.process('Check Vol. 3 page 42');
      expect(result.pageReferences).toEqual({
        volume: 3,
        page: 42,
      });
    });

    it('should parse "page 17" standalone', () => {
      const result = QueryPreprocessor.process('See page 17 for details');
      expect(result.pageReferences).toEqual({
        page: 17,
      });
    });

    it('should return null when no page reference', () => {
      const result = QueryPreprocessor.process('What is the ruling on negligence?');
      expect(result.pageReferences).toBeNull();
    });
  });

  describe('query variants', () => {
    it('should include all keywords as a variant', () => {
      const result = QueryPreprocessor.process('Where did Milner say there is no fraud?');
      expect(result.queryVariants.some(v => v.includes('milner'))).toBe(true);
    });

    it('should include entity-term pairs', () => {
      const result = QueryPreprocessor.process('Did Baker commit fraud?');
      expect(result.queryVariants.some(v =>
        v.toLowerCase().includes('baker') && v.toLowerCase().includes('fraud')
      )).toBe(true);
    });

    it('should handle queries with no entities', () => {
      const result = QueryPreprocessor.process('What is negligence?');
      expect(result.queryVariants.length).toBeGreaterThan(0);
      expect(result.queryVariants.some(v => v.includes('negligence'))).toBe(true);
    });
  });
});
