/**
 * Draft record guard — the `recordStatus` field must survive every projection
 * between the LanceDB row and the consumer. Synthetic fixtures only.
 */
import { pickProvenance } from '../chunk-provenance';
import { sourceToEvidenceItem, sourcesToEvidence } from '../evidence-mapping';
import { buildOutlineContext } from '../evidence-outline';
import type { DeepSearchSource } from '../deep-search';

const source = (over: Partial<DeepSearchSource> = {}): DeepSearchSource => ({
  text: 'The parties agree to mediate.',
  document: 'motion.pdf',
  page: 3,
  score: 0.8,
  citation: '1 CR 12',
  documentId: 'doc-1',
  matchedSubQueries: ['q1'],
  ...over,
});

describe('pickProvenance', () => {
  it('carries recordStatus alongside the structure fields', () => {
    const p = pickProvenance({ documentId: 'doc-1', blockType: 'table', recordStatus: 'draft' });
    expect(p).toEqual({ documentId: 'doc-1', blockType: 'table', recordStatus: 'draft' });
  });

  it('omits recordStatus when absent', () => {
    expect(pickProvenance({ documentId: 'doc-1' })).toEqual({ documentId: 'doc-1' });
  });
});

describe('evidence-mapping', () => {
  it('sourceToEvidenceItem maps recordStatus onto the EvidenceItem', () => {
    const item = sourceToEvidenceItem(source({ recordStatus: 'draft' }), 'retrieval');
    expect(item.recordStatus).toBe('draft');
    expect(item.documentId).toBe('doc-1');
  });

  it('sourcesToEvidence leaves the field off for non-draft sources without a status', () => {
    const [item] = sourcesToEvidence([source()], 'retrieval');
    expect(item).not.toHaveProperty('recordStatus');
  });
});

describe('evidence outline context', () => {
  it('labels draft evidence in the [E#] meta so the planner never treats it as record', () => {
    const items = sourcesToEvidence([source({ recordStatus: 'draft' }), source({ documentId: 'doc-2', page: 9, recordStatus: 'filed' })], 'retrieval');
    const { block } = buildOutlineContext(items, { maxTotalChars: 10_000, perItemChars: 500 });
    expect(block).toContain('[E1] (DRAFT, filing not confirmed)');
    expect(block).toContain('[E2]\n');
    expect(block).not.toContain('[E2] (DRAFT');
  });
});
