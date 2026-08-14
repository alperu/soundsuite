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
