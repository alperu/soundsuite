import { armAtCircle, beginRowPress, ROW_PRESS_SLOP } from '../slot-row-press';

/**
 * The press half of a link drag (#96). The circle is 6.3px at corpus zoom, so
 * the slot's whole row arms it — but only once the press has travelled far
 * enough to be a drag rather than a click, or the row would take click-to-select
 * away from most of the block.
 *
 * The assertion that matters most is the ARM COORDINATES: the plugin resolves
 * the picked socket with `elementsFromPoint`, so a press dispatched at the row's
 * own position finds no socket and arms nothing — failing silently, exactly like
 * the bug this fixes.
 */

function circleAt(x: number, y: number, size = 6.3): Element {
  const el = document.createElement('span');
  el.className = 'output-socket';
  el.getBoundingClientRect = () =>
    ({ left: x, top: y, width: size, height: size, right: x + size, bottom: y + size }) as DOMRect;
  return el;
}

/** A press event shaped the way the handler reads it. */
const press = (x: number, y: number, target: EventTarget | null = null, button = 0) => ({
  clientX: x,
  clientY: y,
  button,
  target,
});

/** Stand-in for `window`, so a test can drive the listeners deterministically. */
function fakeScope() {
  const handlers = new Map<string, Set<EventListener>>();
  return {
    addEventListener: (type: string, fn: EventListener) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => handlers.get(type)?.delete(fn),
    emit(type: string, event: unknown) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(event as Event);
    },
    count: (type: string) => handlers.get(type)?.size ?? 0,
  };
}

describe('beginRowPress', () => {
  it('arms nothing until the press travels past the slop', () => {
    const arm = jest.fn();
    const scope = fakeScope();
    const circle = circleAt(100, 200);
    beginRowPress(press(50, 50), { circleFor: () => circle, arm, target: scope });

    scope.emit('pointermove', { clientX: 50 + ROW_PRESS_SLOP, clientY: 50 });
    expect(arm).not.toHaveBeenCalled();

    scope.emit('pointermove', { clientX: 50 + ROW_PRESS_SLOP + 1, clientY: 50 });
    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledWith(circle);
  });

  it('a press that never travels arms nothing — that is the click that selects', () => {
    const arm = jest.fn();
    const scope = fakeScope();
    beginRowPress(press(50, 50), { circleFor: () => circleAt(0, 0), arm, target: scope });
    scope.emit('pointermove', { clientX: 51, clientY: 51 });
    scope.emit('pointerup', {});
    expect(arm).not.toHaveBeenCalled();
  });

  it('leaves a press that starts ON a socket to the plugin — no double-arm', () => {
    const arm = jest.fn();
    const scope = fakeScope();
    const socket = document.createElement('div');
    socket.className = 'output-socket';
    const inner = document.createElement('span');
    socket.appendChild(inner);

    const taken = beginRowPress(press(50, 50, inner), {
      circleFor: () => circleAt(0, 0),
      arm,
      target: scope,
    });
    expect(taken).toBe(false);
    // Nothing was even wired up, so a later move cannot arm it.
    expect(scope.count('pointermove')).toBe(0);
    scope.emit('pointermove', { clientX: 500, clientY: 500 });
    expect(arm).not.toHaveBeenCalled();
  });

  it('ignores non-primary buttons, so right-click still opens the menu', () => {
    const scope = fakeScope();
    expect(
      beginRowPress(press(50, 50, null, 2), { circleFor: () => circleAt(0, 0), target: scope }),
    ).toBe(false);
    expect(scope.count('pointermove')).toBe(0);
  });

  it('arms only once however far the press keeps travelling', () => {
    const arm = jest.fn();
    const scope = fakeScope();
    beginRowPress(press(0, 0), { circleFor: () => circleAt(10, 10), arm, target: scope });
    scope.emit('pointermove', { clientX: 100, clientY: 0 });
    scope.emit('pointermove', { clientX: 200, clientY: 0 });
    scope.emit('pointermove', { clientX: 300, clientY: 0 });
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('releases its listeners on pointerup and on pointercancel', () => {
    const scope = fakeScope();
    beginRowPress(press(0, 0), { circleFor: () => circleAt(0, 0), target: scope });
    expect(scope.count('pointermove')).toBe(1);
    scope.emit('pointerup', {});
    expect(scope.count('pointermove')).toBe(0);
    expect(scope.count('pointerup')).toBe(0);

    beginRowPress(press(0, 0), { circleFor: () => circleAt(0, 0), target: scope });
    scope.emit('pointercancel', {});
    expect(scope.count('pointermove')).toBe(0);
  });

  it('swallows the click that ends an armed drag, and only then', () => {
    const scope = fakeScope();
    // Armed: the block must not also select itself when the drag lands.
    beginRowPress(press(0, 0), { circleFor: () => circleAt(0, 0), arm: () => {}, target: scope });
    scope.emit('pointermove', { clientX: 100, clientY: 0 });
    scope.emit('pointerup', {});
    expect(scope.count('click')).toBe(1);
    const stop = jest.fn();
    scope.emit('click', { stopPropagation: stop, preventDefault: () => {} });
    expect(stop).toHaveBeenCalled();
    // One-shot: the suppressor must not survive to eat the next real click.
    expect(scope.count('click')).toBe(0);

    // Not armed: the click is the user selecting the block, and must pass.
    beginRowPress(press(0, 0), { circleFor: () => circleAt(0, 0), arm: () => {}, target: scope });
    scope.emit('pointerup', {});
    expect(scope.count('click')).toBe(0);
  });
});

describe('armAtCircle', () => {
  it("presses at the CIRCLE's centre, not wherever the row was touched", () => {
    // The plugin hit-tests `elementsFromPoint` to find the picked socket, so
    // these coordinates are the difference between arming and silently not.
    const circle = circleAt(100, 200, 6.3);
    const seen: PointerEvent[] = [];
    circle.addEventListener('pointerdown', e => seen.push(e as PointerEvent));

    armAtCircle(circle);

    expect(seen).toHaveLength(1);
    expect(seen[0].clientX).toBeCloseTo(103.15, 5);
    expect(seen[0].clientY).toBeCloseTo(203.15, 5);
    // The plugin's listener sits on the socket element and reads a primary press.
    expect(seen[0].button).toBe(0);
    expect(seen[0].bubbles).toBe(true);
  });
});
