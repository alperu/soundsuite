import { useSyncExternalStore } from 'react';

/**
 * The canvas zoom, published so blocks can decide what is worth drawing.
 *
 * Slot labels are the reason this exists: at the editor's opening zoom a 9px
 * label renders around 4px on screen, which is decoration rather than
 * information. Blocks subscribe here and show the label only once it can be
 * read, the same store pattern as the drag state — no `area.update`, so a
 * pinch-zoom doesn't repaint every node through rete.
 */

/** Below this a slot label is too small to read; the tooltip carries it instead. */
export const LABEL_ZOOM_THRESHOLD = 0.7;

let zoom = 1;
const listeners = new Set<() => void>();

export function setZoom(next: number) {
  if (Math.abs(next - zoom) < 0.001) return;
  zoom = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return zoom;
}

function getServerSnapshot(): number {
  return 1;
}

export function useZoom(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export interface CanvasTransform {
  x: number;
  y: number;
  k: number;
}

/**
 * The full transform, for chrome drawn OUTSIDE the canvas — column headers and
 * guide lines that must track pan and zoom.
 *
 * Its own listener set, and deliberately NOT a React store: the headers are
 * positioned imperatively from these callbacks, because re-rendering React on
 * every frame of a pan is exactly the cost this canvas has spent the whole
 * project avoiding.
 */
let transform: CanvasTransform = { x: 0, y: 0, k: 1 };
const transformListeners = new Set<(t: CanvasTransform) => void>();

export function setTransform(next: CanvasTransform) {
  transform = next;
  for (const listener of transformListeners) listener(next);
}

export function subscribeTransform(listener: (t: CanvasTransform) => void): () => void {
  transformListeners.add(listener);
  listener(transform);
  return () => {
    transformListeners.delete(listener);
  };
}
