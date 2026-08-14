import { planLink, slotsForKind, visibleSlotsFor } from '../link-rules';
import { buildScopeGraph, filingKey } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * `orderRef` is one label with TWO write plans, chosen by the source's kind
 * (#89). That is a deliberate fork and a standing trap, so it is DRIVEN here
 * rather than read: every assertion runs planLink and inspects the plan it
 * produced.
 *
 *   motion    → order:  writes `resolves` on the ORDER (inverted; a motion
 *                       stores nothing, its side is derived)
 *   notice/…  → order:  writes `orderRef` on the ATTACHMENT itself, leaving
 *                       parentage and case alone — a reference, not a move
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

const graph = buildScopeGraph([
  {
    id: 'c1',
    name: 'case one',
    unfiledDocCount: 0,
    unfiledIndexedCount: 0,
    filings: [
      filing('m1', 'motion'),
      filing('o1', 'order'),
      filing('j1', 'judgment'),
      filing('n1', 'notice', { motionRef: 'm1' }),
      filing('r1', 'response', { respondingTo: 'm1' }),
      filing('y1', 'reply'),
      filing('b1', 'brief'),
      filing('rec1', 'reportersRecord'),
    ],
  } as ScopeCase,
]);

const plan = (source: string, target: string, slot?: string) =>
  planLink(graph, filingKey(source), filingKey(target), slot);

describe('orderRef — the motion side stays inverted', () => {
  it('writes resolves ON THE ORDER, not orderRef on the motion', () => {
    const result = plan('m1', 'o1', 'orderRef');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.type).toBe('ref');
    if (result.plan.type !== 'ref') return;
    // The write lands on the order…
    expect(result.plan.id).toBe('o1');
    expect(result.plan.slot).toBe('resolves');
    // …pointing back at the motion, and it says so.
    expect(result.plan.targetId).toBe('m1');
    expect(result.plan.wroteOnTarget).toBe(true);
  });

  it('still refuses a target that is not order-shaped', () => {
    const result = plan('m1', 'n1', 'orderRef');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/order, judgment or decree/);
  });
});

describe('orderRef — the attachment side writes directly', () => {
  // `reportersRecord` was one of these exemplars until #101. A records volume
  // owns no Motion/MotionAttachment row and the scope graph reads only its id,
  // so the orderRef it wrote went into a tags bag no read path consults — the
  // #89 property held at the commit layer and nowhere after it. The property
  // itself is unchanged and still pinned across four attachment kinds; see
  // records-kind-slots.test.ts for what those volumes offer now.
  for (const [kind, id] of [
    ['notice', 'n1'],
    ['response', 'r1'],
    ['reply', 'y1'],
    ['brief', 'b1'],
  ] as const) {
    it(`${kind} → order writes orderRef on ITSELF`, () => {
      const result = plan(id, 'o1', 'orderRef');
      expect(result.ok).toBe(true);
      if (!result.ok || result.plan.type !== 'ref') return;
      expect(result.plan.id).toBe(id);
      expect(result.plan.slot).toBe('orderRef');
      expect(result.plan.targetId).toBe('o1');
      // NOT inverted — nothing is written on the order.
      expect(result.plan.wroteOnTarget).toBeUndefined();
    });
  }

  it('accepts every order-shaped kind, not just `order`', () => {
    const result = plan('n1', 'j1', 'orderRef');
    expect(result.ok).toBe(true);
    if (result.ok && result.plan.type === 'ref') expect(result.plan.targetId).toBe('j1');
  });

  it('leaves parentage out of the plan entirely — a reference, not a move', () => {
    const result = plan('n1', 'o1', 'orderRef');
    expect(result.ok).toBe(true);
    if (!result.ok || result.plan.type !== 'ref') return;
    // The plan touches one slot on one row. Nothing about motionRef or the case
    // appears in it, which is what makes this a link rather than a re-filing.
    expect(result.plan.slot).toBe('orderRef');
    expect(Object.keys(result.plan)).not.toContain('caseId');
  });

  it('refuses a non-order target with the rule\'s own sentence', () => {
    const result = plan('n1', 'm1', 'orderRef');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/order, judgment or decree/);
  });
});

describe('the slot is offered wherever it can be used', () => {
  it('every attachment kind carries it, empty or not', () => {
    for (const kind of ['notice', 'response', 'reply', 'brief', 'affidavit']) {
      expect(slotsForKind(kind)).toContain('orderRef');
    }
    // Records volumes are the documented exception (#101): the write had
    // nowhere to be read back from, so the socket is gone rather than dead.
    for (const kind of ['clerksRecord', 'reportersRecord']) {
      expect(slotsForKind(kind)).not.toContain('orderRef');
    }
    // An unset slot is still rendered — it is what you drag FROM.
    expect(visibleSlotsFor('notice', {})).toContain('orderRef');
  });

  it('an order does not get one — its side of that link is `resolves`', () => {
    for (const kind of ['order', 'proposedOrder', 'judgment', 'decree']) {
      expect(slotsForKind(kind)).not.toContain('orderRef');
      expect(slotsForKind(kind)).toContain('resolves');
    }
  });

  it('a motion keeps its inverted one', () => {
    expect(slotsForKind('motion')).toContain('orderRef');
  });
});
