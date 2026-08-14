import { planLink, visibleSlotsFor, slotsForKind } from '../link-rules';
import { buildScopeGraph, filingKey } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * A slot a block RENDERS but its kind cannot write is a held ref — surfaced by
 * `visibleSlotsFor` so the value is visible and the link can be undone.
 *
 * Two things were wrong about `orderRef` (#102). The held-ref scan dropped it
 * for every kind, though the reason for dropping it — a motion's order side is
 * derived, never stored — is true only of motions; an order-shaped filing
 * tagged before `resolves` existed rendered nothing for a value it was holding.
 * And a drag from such a socket fell through to the kind's fallback slot, so
 * pulling an order's held `orderRef` planned a `resolves` write: a different
 * fact, saved without being asked for.
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

const ORDER_SHAPED = ['order', 'proposedOrder', 'judgment', 'decree'] as const;

const graph = buildScopeGraph([
  {
    id: 'c1',
    name: 'case one',
    unfiledDocCount: 0,
    unfiledIndexedCount: 0,
    filings: [
      filing('m1', 'motion'),
      // An order that already holds an orderRef pointing at another order.
      filing('o1', 'order', { orderRef: 'o2' }),
      filing('o2', 'order'),
    ],
  } as ScopeCase,
]);

describe('an order-shaped filing shows the orderRef it holds', () => {
  it('renders the socket for the held value, on every order-shaped kind', () => {
    for (const kind of ORDER_SHAPED) {
      // Not writable there — an order's side of that relationship is `resolves`.
      expect(slotsForKind(kind)).not.toContain('orderRef');
      // But a value it already carries has to be visible to be undone.
      expect(visibleSlotsFor(kind, { orderRef: 'o2' })).toContain('orderRef');
      // Still nothing to show when there is no value.
      expect(visibleSlotsFor(kind, {})).not.toContain('orderRef');
    }
  });

  it('a motion never reached the held scan anyway — it writes the slot', () => {
    // The dropped condition named motions as its reason, but a motion carries
    // `orderRef` as a WRITABLE inversion affordance (the gesture runs motion →
    // order and the write lands on the order as `resolves`), so the held scan's
    // `!writable.includes` check had already excluded it. The exclusion's only
    // real effect was on order-shaped kinds, which is the bug it caused.
    expect(slotsForKind('motion')).toContain('orderRef');
    expect(visibleSlotsFor('motion', {})).toContain('orderRef');
    expect(visibleSlotsFor('motion', { orderRef: 'o2' })).toContain('orderRef');
    // And the motion still stores nothing: pulling it writes on the TARGET.
    const inverted = planLink(graph, filingKey('m1'), filingKey('o2'), 'orderRef');
    expect(inverted.ok).toBe(true);
    if (inverted.ok && inverted.plan.type === 'ref') {
      expect(inverted.plan.slot).toBe('resolves');
      expect(inverted.plan.id).toBe('o2');
      expect(inverted.plan.wroteOnTarget).toBe(true);
    }
  });

  it('leaves the attachment kinds alone — they write it, so it was never held', () => {
    for (const kind of ['notice', 'response', 'reply', 'brief']) {
      expect(slotsForKind(kind)).toContain('orderRef');
      expect(visibleSlotsFor(kind, {})).toContain('orderRef');
    }
  });
});

describe('a drag from a held socket cannot mean another slot', () => {
  it('refuses rather than silently writing the fallback', () => {
    // The bug: this planned `resolves` — pointing the order at the motion it
    // rules on — because the picked slot was not writable and fell through.
    const result = planLink(graph, filingKey('o1'), filingKey('m1'), 'orderRef');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('orderRef');
  });

  it('does not change what an aimed writable socket means', () => {
    const resolves = planLink(graph, filingKey('o1'), filingKey('m1'), 'resolves');
    expect(resolves.ok).toBe(true);
    if (resolves.ok && resolves.plan.type === 'ref') expect(resolves.plan.slot).toBe('resolves');

    const parentage = planLink(graph, filingKey('o1'), filingKey('m1'), 'motionRef');
    expect(parentage.ok).toBe(true);
    if (parentage.ok && parentage.plan.type === 'ref') expect(parentage.plan.slot).toBe('motionRef');
  });

  it('leaves the unaimed drop alone — it never named a slot to honour', () => {
    const unaimed = planLink(graph, filingKey('o1'), filingKey('m1'));
    expect(unaimed.ok).toBe(true);
    if (unaimed.ok && unaimed.plan.type === 'ref') expect(unaimed.plan.slot).toBe('resolves');
  });
});
