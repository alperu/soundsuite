/**
 * Marquee selection over the block canvas.
 *
 * A port of sedonaWebEditor's `useSelectionArea` (itself from rete's
 * lasso-marquee example) with the lasso half left out: a rectangle needs four
 * float comparisons per block, so `intersects` and `poly-decomp` — which exist
 * only to test arbitrary polygons — buy nothing here. The lasso can be added
 * later behind the same `shape` seam; that is where those deps would earn their
 * place.
 *
 * Two things it does NOT copy from the original:
 *  - Hit-testing reads the layout's own boxes, not `getBoundingClientRect` per
 *    node. Blocks are placed by arithmetic and never move, so the layout IS the
 *    truth, and measuring 90 elements mid-drag would force a layout flush on
 *    every pointermove.
 *  - No per-move React state. The rubber band is one absolutely positioned div
 *    written directly, and the pointer loop lives in closures — a re-render per
 *    pointermove across a canvas of this size is not affordable.
 *
 * CAD direction convention, kept verbatim: dragging LEFT-TO-RIGHT selects only
 * blocks fully CONTAINED by the box; RIGHT-TO-LEFT selects anything the box
 * TOUCHES. Shift subtracts instead of adding.
 */

export interface MarqueeResult {
  /** Exactly the blocks the box caught — the caller must not cascade. */
  ids: string[];
  /** True when the drag went left-to-right: containment rather than touch. */
  contain: boolean;
  /** Shift was held: take these out of the selection instead of adding them. */
  subtract: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

export interface MarqueeOptions {
  /** Where the pointer is watched — the element rete owns. */
  container: HTMLElement;
  /** Where the rubber band is drawn: a pointer-events-none sibling overlay. */
  overlay: HTMLElement;
  /** Live canvas transform, read at the moment it's needed. */
  transform: () => { x: number; y: number; k: number };
  /** The layout's boxes, in editor coordinates. */
  boxes: () => Map<string, Box>;
  /** False when the pointer tool is active — the marquee stays out of the way. */
  enabled: () => boolean;
  /** True while something else owns the pointer (a link drag in flight). */
  blocked: () => boolean;
  onSelect: (result: MarqueeResult) => void;
}

/** Shorter than this and the drag was a click; selecting on it would surprise. */
const MIN_DRAG_PX = 3;

/** Screen point → editor coordinates. Verbatim from the original. */
function screenToEditorCoordinates(point: Point, translate: Point, zoom: number): Point {
  return {
    x: (point.x - translate.x) / zoom,
    y: (point.y - translate.y) / zoom,
  };
}

function getPoint(event: PointerEvent, container: HTMLElement): Point {
  const rect = container.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * Which blocks a box in EDITOR coordinates catches.
 *
 * Exported for the unit tests: this is the whole semantic of the gesture, and
 * it is pure arithmetic on the layout — no DOM, no rete.
 */
export function blocksInMarquee(
  boxes: Map<string, Box>,
  a: Point,
  b: Point,
  contain: boolean,
): string[] {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  const hits: string[] = [];
  for (const [id, box] of boxes) {
    const inside = contain
      ? box.x >= x1 && box.y >= y1 && box.x + box.w <= x2 && box.y + box.h <= y2
      : box.x < x2 && box.x + box.w > x1 && box.y < y2 && box.y + box.h > y1;
    if (inside) hits.push(id);
  }
  return hits;
}

/**
 * Wire the marquee onto a canvas. Returns its teardown.
 *
 * Listeners are CAPTURE phase on rete's own container: the area plugin starts
 * panning on `pointerdown` and stops the event, so anything that wants the
 * press first has to take it on the way down.
 */
export function setupMarquee(options: MarqueeOptions): () => void {
  const { container, overlay } = options;

  const band = document.createElement('div');
  band.dataset.canvasChrome = 'marquee';
  band.style.cssText = [
    'position:absolute',
    'display:none',
    'border:1px solid #3b82f6',
    'background:rgba(59,130,246,0.10)',
    'pointer-events:none',
    'z-index:20',
  ].join(';');
  overlay.appendChild(band);

  let start: Point | null = null;
  let current: Point | null = null;
  let subtract = false;
  let capturedPointerId: number | null = null;
  // Space is the pan escape hatch: hold it and the canvas pans whatever tool is
  // selected, which is the only way to reach off-screen blocks mid-marquee.
  let spaceHeld = false;

  const paint = () => {
    if (!start || !current) {
      band.style.display = 'none';
      return;
    }
    band.style.display = 'block';
    band.style.left = `${Math.min(start.x, current.x)}px`;
    band.style.top = `${Math.min(start.y, current.y)}px`;
    band.style.width = `${Math.abs(current.x - start.x)}px`;
    band.style.height = `${Math.abs(current.y - start.y)}px`;
    // Right-to-left is the looser test, and CAD users read the dashed border as
    // exactly that. Saying which rule is in force beats explaining it later.
    band.style.borderStyle = current.x < start.x ? 'dashed' : 'solid';
  };

  const reset = () => {
    start = null;
    current = null;
    subtract = false;
    paint();
    if (capturedPointerId !== null) {
      try {
        container.releasePointerCapture(capturedPointerId);
      } catch {
        /* already released */
      }
      capturedPointerId = null;
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    // Middle button always pans, whatever the tool says; right button belongs
    // to the context menu.
    if (event.button !== 0) return;
    if (!options.enabled() || options.blocked() || spaceHeld) return;
    start = getPoint(event, container);
    current = start;
    subtract = event.shiftKey;
    paint();
    container.setPointerCapture(event.pointerId);
    capturedPointerId = event.pointerId;
    event.preventDefault();
    // Without this the area pans under the band.
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    current = getPoint(event, container);
    paint();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    const end = getPoint(event, container);
    const from = start;
    const wasSubtract = subtract;
    reset();
    if (Math.abs(end.x - from.x) < MIN_DRAG_PX && Math.abs(end.y - from.y) < MIN_DRAG_PX) return;
    const { x, y, k } = options.transform();
    const a = screenToEditorCoordinates(from, { x, y }, k);
    const b = screenToEditorCoordinates(end, { x, y }, k);
    const contain = end.x > from.x;
    options.onSelect({
      ids: blocksInMarquee(options.boxes(), a, b, contain),
      contain,
      subtract: wasSubtract,
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'Space') spaceHeld = true;
    // Escape abandons a drag in progress without selecting anything.
    if (event.key === 'Escape' && start) reset();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'Space') spaceHeld = false;
  };

  container.addEventListener('pointerdown', onPointerDown, true);
  container.addEventListener('pointermove', onPointerMove, true);
  container.addEventListener('pointerup', onPointerUp, true);
  container.addEventListener('pointercancel', onPointerUp, true);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return () => {
    container.removeEventListener('pointerdown', onPointerDown, true);
    container.removeEventListener('pointermove', onPointerMove, true);
    container.removeEventListener('pointerup', onPointerUp, true);
    container.removeEventListener('pointercancel', onPointerUp, true);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    reset();
    band.remove();
  };
}
