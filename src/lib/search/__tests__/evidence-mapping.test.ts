/**
 * Evidence mapping — the citation family must survive the hop from
 * `DeepSearchSource` to `EvidenceItem` (REPORT-v4 N-1). A client that gets a
 * UUID and a paragraph cannot cite anything and will invent citations.
 * Synthetic fixtures only.
 */

import { sourceToEvidenceItem, sourcesToEvidence, evidenceIdFor } from '../evidence-mapping';
import type { DeepSearchSource } from '../deep-search';

const source = (over: Partial<DeepSearchSource> = {}): DeepSearchSource => ({
  text: 'The parties agreed to mediate before the hearing.',
  document: 'motion.pdf',
  page: 12,
  score: 0.71,
  citation: 'Motion to Compel, CAUSE NO. 00-0000-XX, p.12',
  citationShort: 'Mot. Compel 12',
  filingType: 'motion',
  volumeNumber: 2,
  caseNumber: 'CAUSE NO. 00-0000-XX',
  filingSlug: 'motion-to-compel',
  documentId: 'doc-1',
  matchedSubQueries: ['q1'],
  ...over,
});

describe('sourceToEvidenceItem', () => {
  it('carries the whole citation family through', () => {
    const item = sourceToEvidenceItem(source(), 'retrieval');
    expect(item).toMatchObject({
      citation: 'Motion to Compel, CAUSE NO. 00-0000-XX, p.12',
      citationShort: 'Mot. Compel 12',
      page: 12,
      document: 'motion.pdf',
      filingType: 'motion',
      volumeNumber: 2,
      caseNumber: 'CAUSE NO. 00-0000-XX',
      filingSlug: 'motion-to-compel',
    });
    // documentId stays the opaque id; `document` is the readable name.
    expect(item.documentId).toBe('doc-1');
    expect(item.id).toBe(evidenceIdFor(source()));
  });

  it('omits citation fields the retrieval layer did not supply', () => {
    const bare = sourceToEvidenceItem(
      { text: 'A passage.', document: '', page: 0, score: 0.1, matchedSubQueries: [] },
      'retrieval',
    );
    for (const key of ['citation', 'citationShort', 'document', 'filingType', 'caseNumber', 'filingSlug']) {
      expect(bare).not.toHaveProperty(key);
    }
    // page 0 is a number, not "absent" — truthiness must not eat it.
    expect(bare.page).toBe(0);
  });

  it('keeps volumeNumber 0 rather than dropping it as falsy', () => {
    const item = sourceToEvidenceItem(source({ volumeNumber: 0 }), 'retrieval');
    expect(item.volumeNumber).toBe(0);
  });

  it('sourcesToEvidence maps the family for every source', () => {
    const items = sourcesToEvidence([source(), source({ page: 13, citationShort: 'Mot. Compel 13' })], 'retrieval');
    expect(items.map((i) => i.citationShort)).toEqual(['Mot. Compel 12', 'Mot. Compel 13']);
    expect(items.every((i) => i.caseNumber === 'CAUSE NO. 00-0000-XX')).toBe(true);
  });
});
