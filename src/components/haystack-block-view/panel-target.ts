import type { ScopeGraph } from './scope-graph';

/**
 * What clicking a block should put in the tag panel.
 *
 * Extracted from the click handler so the chain the user actually complains
 * about — "I clicked a block and nothing opened" — can be tested without
 * mounting a canvas, a worklist and a TagPanel. The handler keeps the state
 * writes; this owns the decision.
 */

export type PanelTarget =
  /** A row the worklist already knows: the list selection drives the panel. */
  | { kind: 'entry'; entryKey: string }
  /** A block the worklist doesn't list — the canvas supplies the identity. */
  | { kind: 'graph'; entityKind: string; id: string; label: string }
  /** Nothing to edit, and a reason to say so. */
  | { kind: 'refuse'; reason: string }
  /** A key that names nothing on this graph. */
  | { kind: 'none' };

export function panelTargetFor(
  key: string,
  context: {
    graph: ScopeGraph;
    /** Worklist entry keys — bare filing ids, not block keys. */
    entryKeys: Set<string>;
    caseNameById: Map<string, string>;
  },
): PanelTarget {
  if (key.startsWith('document:')) {
    return {
      kind: 'refuse',
      reason: 'A document carries no tags — drag it onto a filing to file it.',
    };
  }
  if (key.startsWith('unfiled:')) {
    return {
      kind: 'refuse',
      reason: 'Unfiled documents have no tag row — file them onto a filing first.',
    };
  }
  if (key.startsWith('case:')) {
    const id = key.slice('case:'.length);
    return {
      kind: 'graph',
      entityKind: 'case',
      id,
      label: context.caseNameById.get(id) ?? 'Case',
    };
  }
  const id = key.slice('filing:'.length);
  // The worklist wins where it has the row: its selection carries the entity
  // TABLE as well as the id, which the canvas cannot know.
  if (context.entryKeys.has(id)) return { kind: 'entry', entryKey: id };
  const block = context.graph.filingById.get(id);
  if (!block) return { kind: 'none' };
  return {
    kind: 'graph',
    // A filing with no entity row yet still has a kind to edit against;
    // falling back to `motion` is what makes an unmapped block editable.
    entityKind: block.primaryKind || 'motion',
    id,
    label: block.label,
  };
}
