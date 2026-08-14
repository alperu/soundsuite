import { planLink } from './link-rules';
import type { DragState } from './drag-state';
import type { ScopeGraph } from './scope-graph';

/**
 * What releasing a link drag over a point on the canvas means.
 *
 * `rete-connection-plugin` proposes a connection only when the release lands on
 * a socket ELEMENT — it hit-tests `elementsFromPoint` against the sockets it
 * registered on render. A socket circle is 14px at 1:1, which is 7px at the
 * zoom the whole corpus fits in, and the input hub sits on ONE edge of the
 * block. So the natural gesture — drag from the slot, let go on the target
 * BLOCK — released on nothing the plugin knew about and did nothing at all:
 * no link, no refusal, no explanation (#93).
 *
 * The whole block is the drop target here. The plugin still owns a release that
 * actually lands on a socket, so the two paths cannot both write.
 */
export type DropOutcome =
  /** Nothing to do: no drag, no block under the pointer, or the plugin's gesture. */
  | { type: 'none' }
  /** Same arguments `connectioncreate` hands the host, from the same rules. */
  | { type: 'commit'; sourceKey: string; targetKey: string; slot?: string }
  /** The pair is not a link this canvas can write — the rules' own sentence. */
  | { type: 'refuse'; reason: string };

/** Sockets the connection plugin owns. Their classes are what `scope-blocks`
 *  renders and what the plugin registered, so this list has one home. */
const SOCKET_SELECTOR = '.input-socket,.output-socket';

/**
 * Decide a release, from the same `planLink` the socket drop obeys.
 *
 * Deliberately NOT `drag.compatible`: that set was computed at PICK time to
 * drive the highlight, and branching on it here would let a stale ring and the
 * commit disagree. One question, asked once, at the moment of the drop.
 */
export function resolveDrop(params: {
  graph: ScopeGraph;
  drag: DragState;
  /** `document.elementsFromPoint` at the release, innermost first. */
  stack: Element[];
}): DropOutcome {
  const { graph, drag, stack } = params;
  if (!drag.active || !drag.sourceKey) return { type: 'none' };

  // A release ON a socket is the plugin's own gesture: it proposes the
  // connection itself, and taking it here too would write the same ref twice.
  if (stack.some(el => el.closest?.(SOCKET_SELECTOR))) return { type: 'none' };

  const block = stack.map(el => el.closest?.('[data-block-id]')).find(Boolean);
  const targetKey = block?.getAttribute('data-block-id');
  if (!targetKey || targetKey === drag.sourceKey) return { type: 'none' };

  // An input-hub drag runs target-first, so the pair goes the other way round —
  // the same mirror `linkVerdicts` applies when it highlights for that side.
  const plan =
    drag.side === 'output'
      ? planLink(graph, drag.sourceKey, targetKey, drag.slot ?? undefined)
      : planLink(graph, targetKey, drag.sourceKey);

  if (!plan.ok) return { type: 'refuse', reason: plan.reason };
  return drag.side === 'output'
    ? { type: 'commit', sourceKey: drag.sourceKey, targetKey, slot: drag.slot ?? undefined }
    : { type: 'commit', sourceKey: targetKey, targetKey: drag.sourceKey };
}
