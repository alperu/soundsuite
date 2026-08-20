/**
 * What a left-press on a block's id circle should mean.
 *
 * The hub is where every inbound ref edge terminates, and rete's ClassicFlow
 * turns a press on an occupied input into a re-route: it removes the connection
 * immediately, which this canvas reads as the unlink gesture. With ONE edge
 * arriving that is unambiguous — there is only one link the gesture could mean.
 * With two or more it is not expressible: every edge ends on the same 6.3px
 * circle, so the press carries no information about which one, and rete picks
 * with `getConnections().find(...)` — the first it happens to hold (#107).
 *
 * Since #105 the circle is the ONLY unlink affordance (the `linkTo` lane owns
 * link-starting), so "destroys an unnamed link" is no longer a corner of a
 * bigger gesture — it is the whole gesture. On a multi-ref hub the press
 * therefore opens the id tag's inbound menu, which names every link by its
 * source and slot and deletes exactly the one chosen. Same menu the right-click
 * already opens; the press stops being a shortcut for "delete something".
 *
 * The behaviour varies with the data, deliberately and narrowly: it varies with
 * whether the gesture CAN mean one thing. That is a different thing from an
 * affordance that appears and disappears for reasons the user cannot see.
 */
export type HubPress =
  /** No inbound edges: nothing to grab, so the plugin starts a fresh link. */
  | 'fresh'
  /** Exactly one: the press names it by elimination — let the plugin grab. */
  | 'grab'
  /** Two or more: ambiguous, so surface the named list instead of guessing. */
  | 'menu';

export function hubPress(inboundCount: number | undefined): HubPress {
  const count = inboundCount ?? 0;
  if (count >= 2) return 'menu';
  if (count === 1) return 'grab';
  return 'fresh';
}

/** True when the canvas must take the press away from the connection plugin. */
export function pressIsAmbiguous(inboundCount: number | undefined): boolean {
  return hubPress(inboundCount) === 'menu';
}
