import { useSyncExternalStore } from 'react';
import type { EntityKey } from './scope-graph';

/**
 * Which block the pointer is over, and which block is PINNED.
 *
 * Same shape as the drag store, and for the same reason: edges read it to
 * decide how loudly to draw themselves, and routing that through rete would
 * repaint every node on a mouse move.
 *
 * The pin exists because hover alone can't survive the gesture that needs it
 * most: opening a menu on a block moves the pointer off the block, so a line
 * revealed by hover would vanish exactly as the user reached for "Show line".
 * A pinned block reads as hovered until something clears it — a click on empty
 * canvas, or Escape.
 */

let hovered: EntityKey | null = null;
let pinned: EntityKey | null = null;
/**
 * Which blocks are SELECTED, mirrored here from whichever store owns selection
 * (the cascade in filtering, the active block in the editor).
 *
 * Mirrored rather than read directly because the consumer is the per-edge
 * component rete renders: it cannot see the tab's React state, and threading
 * selection down through the canvas would rebuild every connection on each
 * change. The tab publishes; edges subscribe.
 */
let selected: ReadonlySet<EntityKey> = new Set();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

export function setHovered(key: EntityKey | null) {
  if (hovered === key) return;
  hovered = key;
  publish();
}

export function setPinned(key: EntityKey | null) {
  if (pinned === key) return;
  pinned = key;
  publish();
}

export function currentPinned(): EntityKey | null {
  return pinned;
}

export function setSelectedBlocks(next: ReadonlySet<EntityKey>) {
  // Same-size, same-members means nothing to publish — this runs on every
  // selection change, including the ones that only moved a case rollup.
  if (next.size === selected.size && [...next].every(key => selected.has(key))) return;
  selected = next;
  publish();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): EntityKey | null {
  return hovered;
}

function getServerSnapshot(): EntityKey | null {
  return null;
}

export function useHovered(): EntityKey | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getPinnedSnapshot(): EntityKey | null {
  return pinned;
}

export function usePinned(): EntityKey | null {
  return useSyncExternalStore(subscribe, getPinnedSnapshot, getServerSnapshot);
}

const EMPTY: ReadonlySet<EntityKey> = new Set();

function getSelectedSnapshot(): ReadonlySet<EntityKey> {
  return selected;
}

function getSelectedServerSnapshot(): ReadonlySet<EntityKey> {
  return EMPTY;
}

export function useSelectedBlocks(): ReadonlySet<EntityKey> {
  return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedServerSnapshot);
}
