import { useSyncExternalStore } from 'react';
import type { EntityKey } from './scope-graph';

/**
 * Which block the pointer is over.
 *
 * Same shape as the drag store, and for the same reason: edges read it to
 * decide how loudly to draw themselves, and routing that through rete would
 * repaint every node on a mouse move.
 */

let hovered: EntityKey | null = null;
const listeners = new Set<() => void>();

export function setHovered(key: EntityKey | null) {
  if (hovered === key) return;
  hovered = key;
  for (const listener of listeners) listener();
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
