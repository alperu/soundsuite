import { resolveDrop } from '../drop-target';
import type { DragState } from '../drag-state';
import { buildScopeGraph, filingKey } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * The regression this pins (#93): a link drag released on the target BLOCK did
 * nothing. `rete-connection-plugin` proposes a connection only when the release
 * hit-tests onto a socket element, and the id socket is a 14px circle on one
 * edge — 7px at the zoom that fits the corpus. The rules accepted the pair the
 * whole time, which is why the failure was silent rather than explained.
 *
 * Tested here rather than through rete: the decision is a pure reading of what
 * the pointer was over, and a canvas harness would prove nothing extra.
 * Fixtures are synthetic.
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
  testCase('c1', [filing('m1', 'motion'), filing('o1', 'order'), filing('n1', 'notice')]),
]);

/** A block element, optionally with a socket child the pointer is over. */
function blockAt(key: string, socketClass?: 'input-socket' | 'output-socket'): Element[] {
  const block = document.createElement('div');
  block.setAttribute('data-block-id', key);
  const inner = document.createElement('div');
  block.appendChild(inner);
  if (!socketClass) return [inner, block];
  const socket = document.createElement('div');
  socket.className = socketClass;
  const circle = document.createElement('span');
  socket.appendChild(circle);
  block.appendChild(socket);
  return [circle, socket, block];
}

const dragging = (over: Partial<DragState> = {}): DragState => ({
  active: true,
  sourceKey: filingKey('m1'),
  slot: 'orderRef',
  side: 'output',
  compatible: new Set(),
  ...over,
});

describe('resolveDrop', () => {
  it('commits a motion→order release that lands on the ORDER BLOCK, not its socket', () => {
    const outcome = resolveDrop({
      graph,
      drag: dragging(),
      stack: blockAt(filingKey('o1')),
    });
    expect(outcome).toEqual({
      type: 'commit',
      sourceKey: filingKey('m1'),
      targetKey: filingKey('o1'),
      slot: 'orderRef',
    });
  });

  it('defers to the connection plugin when a socket is under the pointer', () => {
    // Both paths would write the same ref; only one of them should send it.
    const outcome = resolveDrop({
      graph,
      drag: dragging(),
      stack: blockAt(filingKey('o1'), 'input-socket'),
    });
    expect(outcome).toEqual({ type: 'none' });
  });

  it('refuses with the rules’ own sentence when the block cannot take the slot', () => {
    const outcome = resolveDrop({
      graph,
      drag: dragging(),
      stack: blockAt(filingKey('n1')),
    });
    expect(outcome.type).toBe('refuse');
    expect(outcome.type === 'refuse' && outcome.reason).toMatch(/order/i);
  });

  it('ignores a release on the block the drag started from, and on bare canvas', () => {
    expect(resolveDrop({ graph, drag: dragging(), stack: blockAt(filingKey('m1')) })).toEqual({
      type: 'none',
    });
    const bare = document.createElement('div');
    expect(resolveDrop({ graph, drag: dragging(), stack: [bare] })).toEqual({ type: 'none' });
  });

  it('does nothing when no drag is in flight', () => {
    const idle: DragState = {
      active: false,
      sourceKey: null,
      slot: null,
      side: null,
      compatible: new Set(),
    };
    expect(resolveDrop({ graph, drag: idle, stack: blockAt(filingKey('o1')) })).toEqual({
      type: 'none',
    });
  });

  it('mirrors the pair for an input-hub drag, which runs target-first', () => {
    // Picked the motion's hub, released on the notice's body: the notice is the
    // one that writes, through the slot its kind offers.
    const outcome = resolveDrop({
      graph,
      drag: dragging({ slot: null, side: 'input' }),
      stack: blockAt(filingKey('n1')),
    });
    expect(outcome).toEqual({
      type: 'commit',
      sourceKey: filingKey('n1'),
      targetKey: filingKey('m1'),
    });
  });

  it('never consults the pick-time compatible set — the rules answer at drop time', () => {
    // A stale highlight must not be able to authorise a write the rules refuse.
    const outcome = resolveDrop({
      graph,
      drag: dragging({ compatible: new Set([filingKey('n1')]) }),
      stack: blockAt(filingKey('n1')),
    });
    expect(outcome.type).toBe('refuse');
  });
});
