import { planLink, primarySlotFor, slotsForKind, visibleSlotsFor, type LinkSlot } from '../link-rules';
import { buildScopeGraph, filingKey } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';
import { TAG_SPEC_BY_KIND, rendersWhenEmpty } from '@/components/case/tag-spec';

/**
 * #94 fixed one kind; #100 is the rule behind it. A slot that reaches the block
 * only through `visibleSlotsFor`'s held-ref scan renders on rows that ALREADY
 * hold a value and nowhere else — so the link you cannot see is the link you
 * cannot draw. On the live canvas that hid `motionRef` on every motion, every
 * reply, and every response but the one that happened to have a parent.
 *
 * Both surfaces are pinned, because they are separate mechanisms: `slotsForKind`
 * decides the canvas socket, `alwaysShow` decides the tag-panel row.
 */

/** The kinds a filing block actually speaks for on the canvas. */
const CANVAS_KINDS = [
  'motion',
  'notice',
  'response',
  'reply',
  'order',
  'proposedOrder',
  'judgment',
  'decree',
  'letter',
  'brief',
  'petition',
  'affidavit',
  'objection',
  'supplement',
  'clerksRecord',
  'reportersRecord',
] as const;

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
      filing('m2', 'motion'),
      filing('res1', 'response'),
      filing('rep1', 'reply'),
    ],
  } as ScopeCase,
]);

describe('a writable slot renders on an EMPTY block, on every kind', () => {
  it('renders every slot its kind can write with no refs at all', () => {
    for (const kind of CANVAS_KINDS) {
      const empty = visibleSlotsFor(kind, {});
      for (const slot of slotsForKind(kind)) {
        expect([kind, slot, empty.includes(slot)]).toEqual([kind, slot, true]);
      }
    }
  });

  it('offers the parent-motion socket on the three kinds that hid it', () => {
    // The regression: these reached the block through the held-ref scan alone.
    for (const kind of ['motion', 'response', 'reply']) {
      expect(visibleSlotsFor(kind, {})).toContain('motionRef');
      expect(visibleSlotsFor(kind, { motionRef: 'm1' })).toContain('motionRef');
    }
  });
});

describe('exposing the slot does not move the primary link', () => {
  it('keeps each kind\'s defining link first, and a motion with none', () => {
    expect(primarySlotFor('response')).toBe('respondingTo');
    expect(primarySlotFor('reply')).toBe('replyingTo');
    expect(slotsForKind('response')[0]).toBe('respondingTo');
    expect(slotsForKind('reply')[0]).toBe('replyingTo');
    // A motion's motionRef is an amendment parent, not its place in a chain —
    // the pairing workbench must not start demanding one for every root motion.
    expect(primarySlotFor('motion')).toBeNull();
  });

  it('leaves the unaimed drop meaning what it meant', () => {
    const fromResponse = planLink(graph, filingKey('res1'), filingKey('m1'));
    expect(fromResponse.ok).toBe(true);
    if (fromResponse.ok && fromResponse.plan.type === 'ref') {
      expect(fromResponse.plan.slot).toBe('respondingTo');
    }
    // A motion's unaimed drop onto another motion still means `amends`.
    const fromMotion = planLink(graph, filingKey('m1'), filingKey('m2'));
    expect(fromMotion.ok).toBe(true);
    if (fromMotion.ok && fromMotion.plan.type === 'ref') {
      expect(fromMotion.plan.slot).toBe('amends');
    }
  });
});

describe('pulling the newly exposed socket writes the right row', () => {
  it('writes motionRef on the source itself, never inverted', () => {
    for (const [id, kind] of [['res1', 'response'], ['rep1', 'reply'], ['m1', 'motion']] as const) {
      const result = planLink(graph, filingKey(id), filingKey('m2'), 'motionRef');
      expect([kind, result.ok]).toEqual([kind, true]);
      if (!result.ok || result.plan.type !== 'ref') continue;
      expect(result.plan.slot).toBe('motionRef');
      expect(result.plan.id).toBe(id);
      expect(result.plan.targetId).toBe('m2');
      expect(result.plan.wroteOnTarget).toBeUndefined();
    }
  });

  it('still refuses a motionRef that does not point at a motion', () => {
    const result = planLink(graph, filingKey('res1'), filingKey('rep1'), 'motionRef');
    expect(result.ok).toBe(false);
  });
});

describe('the tag panel advertises every slot the canvas draws', () => {
  it('renders the row unset, in read mode, for each writable slot that has one', () => {
    for (const kind of CANVAS_KINDS) {
      const specs = TAG_SPEC_BY_KIND[kind as keyof typeof TAG_SPEC_BY_KIND] ?? [];
      for (const slot of slotsForKind(kind)) {
        const spec = specs.find(s => s.name === slot);
        // A motion is the one kind with a writable slot and no row of its own:
        // its `orderRef` is the inversion affordance, and the panel carries the
        // derived read-only `orderRefs` list instead. The records kinds used to
        // need this escape hatch too, until #101 narrowed them to the one link
        // the system can round-trip. What is pinned here is that a row which
        // EXISTS is never hidden while the socket is drawn.
        if (!spec) {
          expect([kind, slot]).toEqual(['motion', 'orderRef']);
          continue;
        }
        expect([kind, slot, rendersWhenEmpty(spec, false, false)]).toEqual([kind, slot, true]);
      }
    }
  });

  it('does not advertise a row the canvas refuses to draw', () => {
    // An order's side of the order relationship is `resolves`; there is no
    // orderRef socket on an order, so its panel must not offer an empty one.
    for (const kind of ['order', 'proposedOrder', 'judgment', 'decree'] as const) {
      expect(slotsForKind(kind)).not.toContain('orderRef' as LinkSlot);
      const spec = TAG_SPEC_BY_KIND[kind].find(s => s.name === 'orderRef');
      expect(spec?.alwaysShow).toBeUndefined();
    }
  });
});
