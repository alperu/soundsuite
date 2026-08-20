import { BlockNode } from '../scope-blocks';
import type { FilingBlock, CaseBlock } from '../scope-graph';

/**
 * The `linkTo` lane (#105) and why it must stay empty.
 *
 * rete's ClassicFlow chooses between "start a link" and "grab the existing
 * edge" purely by whether some connection has `targetInput === socket.key`
 * (Idle.pick). The ref hub `in` is the target of every inbound ref edge, so
 * picking it on a block that already has one is a re-route — which this canvas
 * reads as the UNLINK gesture. Measured before this lane existed: a hub-row
 * drag cleared a ref instead of writing one.
 *
 * These tests pin the two halves of the cure: the port EXISTS (so the hub row
 * has something to arm) and it is DISTINCT from the keys the edge pass targets
 * (so nothing can ever be found attached to it).
 */

/** The keys `block-canvas` attaches edges to — ref edges land on `in`,
 *  containment on `contains`. Duplicated here deliberately: if that mapping
 *  ever grows to include the lane, this test is what says so. */
const EDGE_TARGET_KEYS = ['in', 'contains'];

function filing(id: string, primaryKind = 'motion'): FilingBlock {
  return {
    key: `filing:${id}`,
    id,
    primaryKind,
    entityKinds: [primaryKind],
    filingType: primaryKind,
    label: `filing ${id}`,
    refs: {},
    documents: [],
    docCount: 0,
    indexedCount: 0,
    filingDate: null,
    x: 0,
    y: 0,
    caseId: 'c1',
  } as unknown as FilingBlock;
}

describe('the linkTo lane', () => {
  it('exists on a filing block, so a hub row has a socket to arm', () => {
    const node = new BlockNode({ kind: 'filing', data: filing('m1') });
    expect(node.inputs.linkTo).toBeDefined();
  });

  it('is NOT one of the keys the edge pass attaches to', () => {
    // The whole cure in one assertion: no edge can ever report this key as its
    // `targetInput`, so ClassicFlow can never take the re-route branch on it.
    expect(EDGE_TARGET_KEYS).not.toContain('linkTo');
  });

  it('is a lane of its own — distinct from the ref hub and containment', () => {
    const node = new BlockNode({ kind: 'filing', data: filing('m1') });
    for (const key of EDGE_TARGET_KEYS) expect(node.inputs[key]).toBeDefined();
    expect(new Set(['in', 'contains', 'linkTo']).size).toBe(3);
  });

  it('accepts many connections, like the other inputs', () => {
    // A hub that refuses multiples makes rete drop a port's existing edges on
    // every accepted drop — the trap recorded on `in` and `contains`.
    const node = new BlockNode({ kind: 'filing', data: filing('m1') });
    expect(node.inputs.linkTo?.multipleConnections).toBe(true);
  });

  it('is on every node kind, so the base port set does not vary', () => {
    const caseNode = new BlockNode({
      kind: 'case',
      data: { key: 'case:c1', id: 'c1', name: 'case c1', x: 0, y: 0 } as unknown as CaseBlock,
    });
    expect(caseNode.inputs.linkTo).toBeDefined();
  });
});
