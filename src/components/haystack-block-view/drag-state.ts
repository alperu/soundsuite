import { useSyncExternalStore } from 'react';
import type { EntityKey } from './scope-graph';

/**
 * Which blocks can accept the connection currently being dragged.
 *
 * This is deliberately NOT rete state and deliberately not painted through
 * `area.update`: highlighting every block on pick would repaint the whole
 * canvas twice per drag. Blocks subscribe to this store individually, so React
 * re-renders only the ones whose styling actually changes.
 */

export interface DragState {
  active: boolean;
  /** The block the drag started from. */
  sourceKey: EntityKey | null;
  /** The output slot picked, when the drag started from one. */
  slot: string | null;
  /** Which side the drag started on — an input pick runs target-first. */
  side: 'input' | 'output' | null;
  /** Blocks a drop would be accepted on. */
  compatible: Set<EntityKey>;
}

const IDLE: DragState = {
  active: false,
  sourceKey: null,
  slot: null,
  side: null,
  compatible: new Set(),
};

let state: DragState = IDLE;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function beginDrag(
  sourceKey: EntityKey,
  compatible: Set<EntityKey>,
  picked: { slot: string | null; side: 'input' | 'output' },
) {
  state = { active: true, sourceKey, slot: picked.slot, side: picked.side, compatible };
  emit();
}

/** The live snapshot, for callers outside React — the pointerup handler has to
 *  know what was being dragged after the flow has already refused the drop. */
export function currentDrag(): DragState {
  return state;
}

export function endDrag() {
  if (!state.active) return;
  state = IDLE;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): DragState {
  return state;
}

/** Server render has no drag in flight, and the snapshot must be stable. */
function getServerSnapshot(): DragState {
  return IDLE;
}

export function useDragState(): DragState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
