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
  /** A row the worklist already knows: the list selection drives the panel.
   *  `entityKind` names WHICH of the entry's rows to open — an attachment-kind
   *  filing carries a shadow Motion row at the same id, and opening that one is
   *  how a Notice ended up showing MOTION TAGS. */
  | { kind: 'entry'; entryKey: string; entityKind: string }
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
    /** Worklist entries by bare filing id, with the entity kinds each one has
     *  rows for. The kinds matter: the list is only the right place to open a
     *  block if it actually holds that block's OWN row. */
    entryKinds: Map<string, string[]>;
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
  const block = context.graph.filingById.get(id);
  if (!block) return { kind: 'none' };
  // A filing with no entity row yet still has a kind to edit against; falling
  // back to `motion` is what makes an unmapped block editable.
  const primary = block.primaryKind || 'motion';

  // The worklist wins ONLY where it holds this block's own row — its selection
  // carries the entity TABLE, which the canvas cannot know. Where it holds just
  // the shadow Motion, going through the list would open that shadow: a Notice
  // showing MOTION TAGS, which is exactly what the user hit.
  if (context.entryKinds.get(id)?.includes(primary)) {
    return { kind: 'entry', entryKey: id, entityKind: primary };
  }
  return { kind: 'graph', entityKind: primary, id, label: block.label };
}
