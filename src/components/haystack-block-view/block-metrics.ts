/**
 * Block geometry primitives, in one place both the layout and the link rules
 * can read without importing each other.
 *
 * The layout needs the socket pitch (a block must be tall enough to hold its
 * own handles); the link rules need the title height (handles live below it).
 * Before this module those two constants lived in `scope-graph`, which made
 * `scope-graph` → `link-rules` a cycle the moment the layout had to ask which
 * slots a block shows.
 */

/** Diameter of a socket circle, matching what `SocketCircle` paints. */
export const SOCKET_D = 14;

/**
 * Minimum centre-to-centre distance between two handles on the same edge.
 * A circle is 14px, so this leaves 2px of daylight — below that adjacent
 * circles touch and, a pixel later, overlap.
 */
export const SLOT_PITCH = 16;

/** Clearance kept between the outermost handle and the block's own edges. */
const EDGE_PAD = 6;

/** The filing block's title bar. Handles live BELOW it — the anchor helper
 *  excludes this band so no circle lands on the filing's name. */
export const BLOCK_TITLE_H = 24;

/**
 * The filing block's footer: kind chip, doc count, unmapped badge.
 *
 * Those three used to sit in the body, sharing it with the slot handles and
 * their labels — which is why the labels needed right-padding and why a fourth
 * handle started crowding the badges. Giving them a band of their own leaves
 * the body to the slots, and both bands are excluded from the anchor maths.
 */
export const BLOCK_FOOTER_H = 20;

/** Body height when the handles don't ask for more: room for two lines of
 *  badges under the title. */
const BODY_MIN = 52;

/**
 * How tall a filing block's body must be to hold `members` handles on one edge
 * without them touching.
 *
 * `members` counts everything drawn on that edge, the input hub included. That
 * distinction is the whole of bug #65: the hub was laid out on its own ratio
 * scale while the slots divided the body between them, and on every filing the
 * hub and the first slot landed on exactly the same pixel.
 */
export function filingBodyFor(members: number): number {
  const span = Math.max(0, members - 1) * SLOT_PITCH + SOCKET_D + 2 * EDGE_PAD;
  return Math.max(BODY_MIN, span);
}

/** Total block height for a given per-edge handle count. */
export function filingHeightFor(members: number): number {
  return BLOCK_TITLE_H + filingBodyFor(members) + BLOCK_FOOTER_H;
}

/**
 * Where one member of an edge stack sits, as a fraction of block height.
 *
 * The stack is centred in the body at a FIXED pitch rather than dividing the
 * body into equal shares. Equal shares (`(i+1)/(n+1)`) shrink as handles are
 * added, which is how three 14px circles ended up 12.6px apart; a fixed pitch
 * instead makes the block ask for the height it needs, once, in the layout.
 *
 * Anything not on this edge answers with the body's centre — that is where a
 * socket with no rendered handle (a slot the kind no longer offers) anchors.
 */
export function anchorRatio(
  key: string,
  stack: readonly string[],
  height: number,
  /**
   * The bands to keep clear, top and bottom. Filings have both; a case block
   * and the unfiled pile have neither, and passing a filing's 24px title there
   * is what put the containment fan 12px below the circle it lands on (#77) —
   * the anchor measured from a band the block never drew.
   */
  bands: { titleH?: number; footerH?: number } = {},
): number {
  const titleH = bands.titleH ?? BLOCK_TITLE_H;
  const footerH = bands.footerH ?? BLOCK_FOOTER_H;
  const centre = titleH + (height - titleH - footerH) / 2;
  const index = stack.indexOf(key);
  if (index < 0) return centre / height;
  return (centre + (index - (stack.length - 1) / 2) * SLOT_PITCH) / height;
}
