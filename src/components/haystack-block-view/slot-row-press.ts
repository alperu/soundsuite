import { CLICK_SLOP } from './block-metrics';
/**
 * Starting a link drag from anywhere along a slot's ROW, not just its circle.
 *
 * The circle is 14px by design, which is 6.3px at the zoom that fits a corpus
 * on screen — and the press is the half of the gesture #93 never touched, so a
 * user who grabbed the block instead of the dot got nothing at all: no pick, no
 * drag, no refusal (#96). Each slot now owns a transparent row along its own
 * edge of the block, half the block wide and one SLOT_PITCH tall.
 *
 * The row does not become a socket. It ARMS the real one: on the press
 * travelling far enough to read as a drag, it dispatches a `pointerdown` AT THE
 * CIRCLE'S CENTRE, and `rete-connection-plugin` picks it up through exactly the
 * code path a direct circle press uses. One path, so the row and the circle
 * cannot come to mean different things.
 *
 * (A synthetic event is the mechanism here, not the verification — #76's lesson
 * is that a synthetic event proves nothing about a real gesture, and the row is
 * still verified end-to-end with trusted input.)
 *
 * Deliberately NOT by enlarging the element the plugin registered: `findSocket`
 * would then match it at RELEASE too, so `resolveDrop` would bail to ClassicFlow
 * for a drop anywhere in the band — and ClassicFlow wants an INPUT socket, so it
 * would refuse. That would re-break #93 across half of every block.
 */

/** Re-exported so a reader of this file sees which distance governs, without
 *  a second constant that could drift from the canvas's. */
export { CLICK_SLOP as ROW_PRESS_SLOP };

/** Sockets the connection plugin owns — a press that starts on one is already
 *  its gesture and must not be armed a second time. */
const SOCKET_SELECTOR = '.input-socket,.output-socket';

export interface RowPressOptions {
  /** The circle this row speaks for. Read lazily: a re-render between the press
   *  and the threshold would leave a captured element detached. */
  circleFor: () => Element | null;
  /** Distance before arming. */
  slop?: number;
  /** Injected by tests. Production dispatches at the circle's centre. */
  arm?: (circle: Element) => void;
  /** Injected by tests — where the window listeners go. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/** The press that arms the plugin, aimed at the CIRCLE rather than at the row.
 *  The coordinates are the whole point: the plugin resolves the picked socket
 *  with `elementsFromPoint`, so a press dispatched at the row's own position
 *  would hit-test to the row, find no socket, and arm nothing — silently. */
export function armAtCircle(circle: Element) {
  const box = circle.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
  };
  // jsdom has no `PointerEvent`. Everything downstream reads only the mouse
  // half of it — the plugin takes `clientX`/`clientY` and calls `preventDefault`
  // — so a `MouseEvent` of the same type is a faithful stand-in where the real
  // constructor is missing, rather than a reason to skip the test.
  circle.dispatchEvent(
    typeof PointerEvent === 'function'
      ? new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent('pointerdown', init),
  );
}

/**
 * Wire one press on a slot row.
 *
 * Returns whether the press was taken up at all — a press on the circle itself,
 * or with a button other than the primary one, is left entirely alone.
 *
 * The real pointerdown is NEVER `preventDefault`ed: that would suppress the
 * compatibility mouse events and take click-to-select away from the whole band,
 * which is the thing this must not cost.
 */
export function beginRowPress(
  event: { clientX: number; clientY: number; button: number; target: EventTarget | null },
  options: RowPressOptions,
): boolean {
  if (event.button !== 0) return false;
  const from = event.target as Element | null;
  if (from?.closest?.(SOCKET_SELECTOR)) return false;

  const slop = options.slop ?? CLICK_SLOP;
  const arm = options.arm ?? armAtCircle;
  const scope = options.target ?? window;
  const start = { x: event.clientX, y: event.clientY };
  let armed = false;

  const move = (moved: Event) => {
    const point = moved as unknown as { clientX: number; clientY: number };
    if (Math.hypot(point.clientX - start.x, point.clientY - start.y) <= slop) return;
    const circle = options.circleFor();
    if (circle) {
      armed = true;
      arm(circle);
    }
    // The question is answered — a press that travelled is never going to
    // become a click — but the release still has to run, both to clean up and
    // to swallow the click an armed drag would otherwise end with.
    scope.removeEventListener('pointermove', move, true);
  };

  const finish = () => {
    // A drag that armed must not also select the block it started on. The
    // suppressor is one-shot AND timed out: a gesture that releases where no
    // common ancestor is clickable fires no `click` at all, and a listener left
    // waiting for one would eat the user's next real click.
    if (armed) {
      const swallow = (click: Event) => {
        click.stopPropagation();
        click.preventDefault();
        scope.removeEventListener('click', swallow, true);
      };
      scope.addEventListener('click', swallow, true);
      setTimeout(() => scope.removeEventListener('click', swallow, true), 0);
    }
    stop();
  };

  function stop() {
    scope.removeEventListener('pointermove', move, true);
    scope.removeEventListener('pointerup', finish, true);
    scope.removeEventListener('pointercancel', finish, true);
  }

  scope.addEventListener('pointermove', move, true);
  scope.addEventListener('pointerup', finish, true);
  scope.addEventListener('pointercancel', finish, true);
  return true;
}
