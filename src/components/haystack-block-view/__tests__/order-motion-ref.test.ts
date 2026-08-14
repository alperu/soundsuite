import { planLink, primarySlotFor, slotsForKind, visibleSlotsFor } from '../link-rules';
import { buildScopeGraph, filingKey } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';
import { TAG_SPEC_BY_KIND, rendersWhenEmpty } from '@/components/case/tag-spec';

/**
 * An order has TWO motion pointers and they are not the same fact: `resolves`
 * is what it rules on, `motionRef` is what it was filed under. Only `resolves`
 * was always-visible (#88), so `motionRef` appeared on an order ONLY once it
 * already held a value — a freshly added order rendered no filed-under socket
 * and no filed-under panel row, which is the link you open the order to draw
 * (#94). Both surfaces are pinned here because they are separate mechanisms:
 * `slotsForKind` for the canvas, `alwaysShow` for the tag panel.
 */

const ORDER_SHAPED = ['order', 'proposedOrder', 'judgment', 'decree'];

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
    filings: [filing('m1', 'motion'), filing('o1', 'order'), filing('n1', 'notice')],
  } as ScopeCase,
]);

describe('an order offers motionRef whether or not it holds one', () => {
  it('every order-shaped kind writes it', () => {
    for (const kind of ORDER_SHAPED) {
      expect(slotsForKind(kind)).toContain('motionRef');
      expect(slotsForKind(kind)).toContain('resolves');
    }
  });

  it('renders on an order with no refs at all — the fresh-order case', () => {
    // The pre-fix behaviour: this slot arrived only through the held-ref scan,
    // so an order with `{}` showed nothing to drag from.
    expect(visibleSlotsFor('order', {})).toContain('motionRef');
    expect(visibleSlotsFor('order', { motionRef: 'm1' })).toContain('motionRef');
  });

  it('leaves `resolves` the primary link and the unaimed fallback', () => {
    for (const kind of ORDER_SHAPED) {
      expect(primarySlotFor(kind)).toBe('resolves');
      expect(slotsForKind(kind)[0]).toBe('resolves');
    }
    // An unaimed drop from an order still means the ruling, not parentage.
    const unaimed = planLink(graph, filingKey('o1'), filingKey('m1'));
    expect(unaimed.ok).toBe(true);
    if (unaimed.ok && unaimed.plan.type === 'ref') expect(unaimed.plan.slot).toBe('resolves');
  });

  it('writes motionRef on the order itself when that socket is the one pulled', () => {
    const result = planLink(graph, filingKey('o1'), filingKey('m1'), 'motionRef');
    expect(result.ok).toBe(true);
    if (!result.ok || result.plan.type !== 'ref') return;
    expect(result.plan.slot).toBe('motionRef');
    // Not inverted: the row that changes is the order's own.
    expect(result.plan.id).toBe('o1');
    expect(result.plan.targetId).toBe('m1');
    expect(result.plan.wroteOnTarget).toBeUndefined();
  });

  it('still refuses a target that is not a motion', () => {
    const result = planLink(graph, filingKey('o1'), filingKey('n1'), 'motionRef');
    expect(result.ok).toBe(false);
  });
});

describe('the tag panel agrees with the canvas', () => {
  it('shows the empty motionRef row on order-shaped kinds in read mode', () => {
    for (const kind of ORDER_SHAPED) {
      const spec = TAG_SPEC_BY_KIND[kind as keyof typeof TAG_SPEC_BY_KIND]
        ?.find(s => s.name === 'motionRef');
      expect(spec).toBeDefined();
      expect(rendersWhenEmpty(spec!, false, false)).toBe(true);
    }
  });

  it('does not promote it on kinds that are not order-shaped', () => {
    const spec = TAG_SPEC_BY_KIND.notice.find(s => s.name === 'motionRef');
    expect(spec).toBeDefined();
    expect(spec!.alwaysShow).toBeUndefined();
  });
});
