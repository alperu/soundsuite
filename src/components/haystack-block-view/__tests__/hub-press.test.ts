import { hubPress, pressIsAmbiguous } from '../hub-press';

/**
 * The decision #107 turns on: when does a press on the id circle carry enough
 * information to name a link? Tested as a predicate rather than through the DOM
 * so it survives however the interception is wired.
 */
describe('hubPress', () => {
  it('lets the plugin start a fresh link when nothing points here', () => {
    expect(hubPress(0)).toBe('fresh');
    expect(hubPress(undefined)).toBe('fresh');
  });

  it('lets the plugin grab when exactly one edge arrives — the press names it', () => {
    expect(hubPress(1)).toBe('grab');
  });

  it('opens the named menu once two or more arrive', () => {
    // Every inbound edge ends on the same circle, so the press cannot say which
    // one is meant and rete would take whichever it holds first.
    expect(hubPress(2)).toBe('menu');
    expect(hubPress(7)).toBe('menu');
  });

  it('pressIsAmbiguous is exactly the menu case', () => {
    expect([0, 1].map(pressIsAmbiguous)).toEqual([false, false]);
    expect([2, 3, 40].map(pressIsAmbiguous)).toEqual([true, true, true]);
  });
});
