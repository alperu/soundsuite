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
 * Centre-to-centre distance between two handles on the same edge.
 *
 * 22, not the 14 a circle strictly needs: the pitch is what caps how large a
 * slot LABEL can be drawn, and at 16 the cap left labels at 5.2px on screen at
 * the 0.45 the editor opens at — present but not readable. 22 buys ~7px there.
 * It costs height, since block bodies are sized from this, and that trade was
 * made deliberately (#87): more readable labels for a taller canvas.
 */
export const SLOT_PITCH = 22;

/**
 * Pointer travel, in px, above which a press-and-release stops being a click.
 *
 * ONE definition on purpose. The canvas reads it to tell a pan from a
 * background click; a slot row reads it to tell a link drag from a
 * click-to-select (#96). Two constants that happen to both be 4, under a
 * comment claiming they agree, is the drift #46 already paid for once.
 */
export const CLICK_SLOP = 4;

/** Clearance kept between the outermost handle and the block's own edges. */
const EDGE_PAD = 6;

/** One line of the title bar, including its share of the vertical padding. */
const TITLE_LINE_H = 15;

/** Padding above and below the title text, together. */
const TITLE_PAD = 9;

/**
 * The filing block's title bar at ONE line — the floor, and the value anything
 * without a label of its own falls back to. Handles live BELOW the bar, and
 * the anchor helper excludes it, so a block whose title grows must pass its own
 * height everywhere the band is measured (#77's lesson, now per block).
 */
export const BLOCK_TITLE_H = TITLE_LINE_H + TITLE_PAD;

/**
 * Longest title we will draw before the rest becomes an ellipsis.
 *
 * FIVE, measured rather than picked. Rendered against every real title, the
 * longest wraps to five lines; four left three names still cut off. Five covers
 * the corpus completely, and the cost lands on the row pitch, which follows the
 * tallest title in the graph.
 *
 * It is still a cap, not "unlimited": a pathological name clips at five lines
 * and keeps the full text in its tooltip. Without a ceiling one bad title would
 * set the pitch for every row on the canvas.
 */
const MAX_TITLE_LINES = 5;

/**
 * Fallback character width, used only where text cannot be measured (jest's
 * jsdom returns nothing useful from `measureText`). Calibrated against real
 * titles, and deliberately generous — a spare line is invisible, a clipped
 * name is the bug.
 */
const TITLE_CHAR_W = 7.0;

/**
 * A canvas context kept for measuring, created once.
 *
 * The layout runs in the browser, so it can ask the same engine that will do
 * the wrapping how wide a word is, rather than estimating from a character
 * count. Estimation was wrong in a way no constant could fix: titles carrying
 * long unbreakable tokens wrapped at ~19 characters per line where an average
 * predicted 35, and three names stayed clipped through two calibration passes.
 */
let measurer: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number | null {
  if (measurer === undefined) {
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    measurer = canvas?.getContext('2d') ?? null;
  }
  if (!measurer) return null;
  measurer.font = font;
  const width = measurer.measureText(text).width;
  // jsdom answers 0 for everything; treat that as "cannot measure".
  return width > 0 ? width : null;
}

/** The title bar's font, as the block renders it. */
const TITLE_FONT = '500 12px ui-sans-serif, system-ui, -apple-system, sans-serif';

/**
 * How many lines this label really takes, by greedy word wrap — the same rule
 * the browser applies. A single word wider than the line gets its own line and
 * overflows rather than looping forever.
 */
function wrappedLines(label: string, width: number, font: string): number | null {
  const space = textWidth(' ', font);
  if (space === null) return null;
  let lines = 1;
  let used = 0;
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const w = textWidth(word, font) ?? 0;
    if (used === 0) {
      used = w;
    } else if (used + space + w <= width) {
      used += space + w;
    } else {
      lines += 1;
      used = w;
    }
    // A word too wide for the line pushes the next one down as well.
    while (used > width && lines < 64) {
      lines += 1;
      used -= width;
    }
  }
  return lines;
}

export function titleHeightFor(label: string, width: number): number {
  const text = label ?? '';
  const measured = text ? wrappedLines(text, width, TITLE_FONT) : 1;
  const estimated = Math.ceil(text.length / Math.max(1, Math.floor(width / TITLE_CHAR_W)));
  const lines = Math.min(MAX_TITLE_LINES, Math.max(1, measured ?? estimated));
  return lines * TITLE_LINE_H + TITLE_PAD;
}

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

/**
 * Total block height for a handle count and a title bar.
 *
 * `titleH` defaults to the one-line bar so every existing caller keeps its
 * meaning; a block with a two- or three-line name passes its own.
 */
export function filingHeightFor(members: number, titleH: number = BLOCK_TITLE_H): number {
  return titleH + filingBodyFor(members) + BLOCK_FOOTER_H;
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
