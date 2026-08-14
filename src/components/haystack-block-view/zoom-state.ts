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

/**
 * Slot labels do not disappear at a threshold any more — they GROW to stay
 * legible as the canvas shrinks.
 *
 * A hard cut at 0.7 hid every label at the 0.45 the editor opens at, which is
 * where a user actually starts reading. Instead the font is sized in editor
 * units so that, once the canvas scale is applied, it never renders smaller
 * than `LABEL_MIN_SCREEN_PX` on the user's screen.
 *
 * Below `LABEL_MIN_ZOOM` even that stops being worth it. The floor is derived,
 * not guessed: the capped font is 11.5 editor px, so at 0.39 it renders at
 * ~4.5px on screen, and below that a label is a grey smudge that costs more
 * attention than it returns. The tooltips carry the names from there down.
 */
export const LABEL_MIN_ZOOM = 0.39;

/** What a label must never render smaller than, in real screen pixels. */
const LABEL_MIN_SCREEN_PX = 7;

/** Its size at 1:1, where no compensation is needed. */
const LABEL_BASE_PX = 9;

/**
 * The ceiling, and it is geometry rather than taste: handles sit 16 editor px
 * apart, so a label box taller than that collides with its neighbour's. At
 * 11.5px the box lands just under the pitch. Measured without this cap, labels
 * at 0.45 grew to 18.8px tall and 166 pairs overlapped — legible text stacked
 * on top of other legible text is not an improvement.
 */
const LABEL_MAX_EDITOR_PX = 11.5;

/**
 * Font size in EDITOR units — the canvas multiplies it by the zoom, so this
 * counteracts the shrink. At zoom 1 it is 9px; at 0.45 it is 15.6 editor px,
 * which lands as 7px on screen instead of 4.
 *
 * Editor units on purpose: the label is inside the transformed layer, and a
 * screen-unit font there would need a counter-transform, which moves the label
 * relative to its circle.
 */
export function labelFontSize(zoom: number): number {
  const wanted = Math.max(LABEL_BASE_PX, LABEL_MIN_SCREEN_PX / Math.max(zoom, 0.01));
  return Math.min(wanted, LABEL_MAX_EDITOR_PX);
}

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
