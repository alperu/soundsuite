import { compatibleKeys, linkVerdicts } from '../link-rules';
import { buildScopeGraph, filingKey } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * `linkVerdicts` is what the drag highlight, the picker and (next) the menus
 * all ask. The property that matters is that they get the SAME answer a real
 * drop would give, from both sides of the gesture. Fixtures are synthetic.
 */

function filing(id: string, primaryKind: string, refs: Record<string, string> = {}): ScopeFiling {
  return {
    id,
    filingType: primaryKind,
    label: `filing ${id}`,
    docCount: 0,
    indexedCount: 0,
    refs,
    documents: [],
    entityKinds: [primaryKind],
    primaryKind,
    filingDate: null,
  };
}

function testCase(id: string, filings: ScopeFiling[]): ScopeCase {
  return { id, name: `case ${id}`, filings, unfiledDocCount: 0, unfiledIndexedCount: 0 };
}

const graph = buildScopeGraph([
  testCase('c1', [
    filing('m1', 'motion'),
    filing('r1', 'response'),
    filing('o1', 'order'),
  ]),
]);

const verdictFor = (list: ReturnType<typeof linkVerdicts>, id: string) =>
  list.find(v => v.key === filingKey(id));

describe('linkVerdicts', () => {
  it('answers for every other block, never for the source itself', () => {
    const list = linkVerdicts(graph, filingKey('r1'), { slot: 'respondingTo', side: 'output' });
    expect(list.some(v => v.key === filingKey('r1'))).toBe(false);
    // Three filings plus the case block, minus the source.
    expect(list).toHaveLength(3);
  });

  it('carries the plan on a yes and a readable sentence on a no', () => {
    const list = linkVerdicts(graph, filingKey('r1'), { slot: 'respondingTo', side: 'output' });
    const yes = verdictFor(list, 'm1');
    expect(yes?.ok).toBe(true);
    expect(yes?.plan).toBeDefined();

    const no = verdictFor(list, 'o1');
    expect(no?.ok).toBe(false);
    // The refusal is the rule's own words, not a boolean dressed up late.
    expect(no?.reason).toMatch(/motion/i);
  });

  it('asks the MIRROR question from the input hub', () => {
    // From a motion's hub the question is "does any slot the candidate writes
    // accept me?" — a response does (respondingTo), so it qualifies even though
    // the motion itself writes nothing outward.
    const hub = linkVerdicts(graph, filingKey('m1'), { side: 'input' });
    expect(verdictFor(hub, 'r1')?.ok).toBe(true);

    // The same pair from the output side is a different question, and a motion
    // has no slot that points at a response.
    const out = linkVerdicts(graph, filingKey('m1'), { side: 'output' });
    expect(verdictFor(out, 'r1')?.ok).toBe(false);
  });

  it('gives a hub refusal the reason an unaimed drop would produce', () => {
    // A case block can never point at a filing through any slot.
    const hub = linkVerdicts(graph, filingKey('m1'), { side: 'input' });
    const caseVerdict = hub.find(v => v.key.startsWith('case:'));
    expect(caseVerdict?.ok).toBe(false);
    expect(typeof caseVerdict?.reason).toBe('string');
    expect(caseVerdict?.reason?.length).toBeGreaterThan(0);
  });

  it('compatibleKeys is exactly the yes half', () => {
    const list = linkVerdicts(graph, filingKey('r1'), { slot: 'respondingTo', side: 'output' });
    const set = compatibleKeys(graph, filingKey('r1'), { slot: 'respondingTo', side: 'output' });
    expect(set).toEqual(new Set(list.filter(v => v.ok).map(v => v.key)));
    expect(set.has(filingKey('m1'))).toBe(true);
  });

  it('a structural slot is offered only when it is asked for by name', () => {
    // caseRef names the case block; asking for it explicitly is what a drag
    // from that socket does.
    const caseRef = linkVerdicts(graph, filingKey('m1'), { slot: 'caseRef', side: 'output' });
    expect(caseRef.find(v => v.key.startsWith('case:'))?.ok).toBe(false);
    // (Same case — the filing is already there — so the refusal is the useful
    // answer rather than a silent yes.)
    expect(caseRef.find(v => v.key.startsWith('case:'))?.reason).toBeDefined();
  });
});
