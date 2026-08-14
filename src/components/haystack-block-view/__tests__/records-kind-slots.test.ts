import { planLink, primarySlotFor, slotsForKind, visibleSlotsFor } from '../link-rules';
import { buildScopeGraph, filingKey } from '../scope-graph';
import { buildWorkbenchRows } from '../pairing-workbench';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * A Clerk's / Reporter's Record owns a record row and no Motion or
 * MotionAttachment row, and the scope graph selects only `{ id: true }` from
 * those two tables (`app/api/scope/graph/route.ts:95-96`, refs built from
 * motions and attachments alone at :119-125). Their `refs` is therefore always
 * `{}`.
 *
 * The generic branch of `slotsForKind` was handing them motionRef, orderRef,
 * amends and supersedes anyway. Those sockets accepted drops: the write landed
 * in the record row's tags JSON, no read path consulted it, and the link could
 * never be drawn, replaced or undone. `motionRef` was even their primary slot,
 * so every one of them sat in the pairing workbench demanding a parent motion
 * that could not stick (#101).
 *
 * They keep the one link the system round-trips: the case, drawn from
 * `Filing.caseId`.
 */

const RECORD_KINDS = ['clerksRecord', 'reportersRecord'] as const;
/** What the generic branch used to hand them. */
const SWALLOWED = ['motionRef', 'orderRef', 'amends', 'supersedes'] as const;

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
      filing('n1', 'notice'),
      filing('rr1', 'reportersRecord'),
      filing('cr1', 'clerksRecord'),
    ],
  } as ScopeCase,
]);

describe('a records volume offers only the link that round-trips', () => {
  it('carries caseRef and nothing else', () => {
    for (const kind of RECORD_KINDS) {
      expect(slotsForKind(kind)).toEqual(['caseRef']);
      expect(visibleSlotsFor(kind, {})).toEqual(['caseRef']);
    }
  });

  it('does NOT offer the slots whose writes the canvas could never read back', () => {
    // Pinned by name so a future edit to the generic branch cannot silently
    // hand these back — that branch is where they came from.
    for (const kind of RECORD_KINDS) {
      for (const slot of SWALLOWED) {
        expect([kind, slot, slotsForKind(kind).includes(slot)]).toEqual([kind, slot, false]);
      }
    }
  });

  it('leaves the other kinds\' lists untouched', () => {
    expect(slotsForKind('notice')).toEqual([
      'motionRef', 'amends', 'supersedes', 'orderRef', 'caseRef',
    ]);
    expect(slotsForKind('order')).toEqual([
      'resolves', 'motionRef', 'amends', 'supersedes', 'caseRef',
    ]);
  });
});

describe('the dead drops are refused rather than swallowed', () => {
  it('refuses a motionRef aimed from a records volume', () => {
    for (const id of ['rr1', 'cr1']) {
      const result = planLink(graph, filingKey(id), filingKey('m1'), 'motionRef');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('motionRef');
    }
  });

  it('refuses an unaimed drop with the caseRef instruction, not a silent write', () => {
    // The only writable slot is structural, so an unaimed drag has nothing it
    // could honestly mean.
    const result = planLink(graph, filingKey('rr1'), filingKey('m1'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('caseRef');
  });

  it('still lets the case link be drawn', () => {
    const target = planLink(graph, filingKey('rr1'), 'case:c1', 'caseRef');
    // Already in that case, so the rules refuse for the RIGHT reason — the
    // gesture is understood, the move is a no-op.
    expect(target.ok).toBe(false);
    if (!target.ok) expect(target.reason).toContain('already in that case');
  });
});

describe('the pairing workbench stops demanding an impossible parent', () => {
  it('has no primary link for a records volume', () => {
    for (const kind of RECORD_KINDS) expect(primarySlotFor(kind)).toBeNull();
  });

  it('drops those rows and keeps everyone else', () => {
    const rows = buildWorkbenchRows(graph);
    const kinds = rows.map(r => r.kind);
    expect(kinds).not.toContain('reportersRecord');
    expect(kinds).not.toContain('clerksRecord');
    // The notice still wants its parent motion — the change is scoped.
    expect(rows.find(r => r.kind === 'notice')?.slot).toBe('motionRef');
  });
});
