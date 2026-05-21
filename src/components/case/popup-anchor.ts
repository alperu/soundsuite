/**
 * popup-anchor — shared viewport-aware positioning helper for the right-edge
 * tag-panel pickers (MotionTypePicker, RefPicker, MarkerPicker).
 *
 * The pickers sit in the right-edge column of `/case-management/*` pages.
 * When their popup is anchored to the input's left edge, a 480 px wide
 * popup falls off the right side of the viewport and the user can't read it.
 *
 * `pickAnchor` decides whether the popup should:
 *  - anchor its LEFT edge to the input's left edge (default — popup grows
 *    to the right), or
 *  - anchor its RIGHT edge to the input's right edge (flipped — popup grows
 *    to the left)
 *  - open BELOW the input (default), or ABOVE if there isn't room below.
 *
 * The caller applies the anchor either via Tailwind `left-0` / `right-0`
 * for an absolutely-positioned popup inside a `position: relative` wrapper,
 * or by mapping it to computed pixel coordinates for a fixed-position popup.
 */

export type HorizontalAnchor = 'left' | 'right';
export type VerticalAnchor = 'below' | 'above';

export interface PopupAnchor {
  /**
   * 'left'  → popup's LEFT edge aligns with input's LEFT edge (default).
   * 'right' → popup's RIGHT edge aligns with input's RIGHT edge (flipped).
   */
  horizontal: HorizontalAnchor;
  /**
   * 'below' → popup opens below the input (default).
   * 'above' → popup opens above the input (flipped).
   */
  vertical: VerticalAnchor;
}

const VIEWPORT_MARGIN_PX = 8;

/**
 * Pick a viewport-aware anchor for a popup of `popupW` × `popupH` pixels
 * anchored to the input rect `inputRect`. Falls back to ('left', 'below')
 * when neither orientation fits — the caller still clamps via `max-width`.
 */
export function pickAnchor(
  inputRect: DOMRect,
  popupW: number,
  popupH: number,
): PopupAnchor {
  if (typeof window === 'undefined') {
    return { horizontal: 'left', vertical: 'below' };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = VIEWPORT_MARGIN_PX;

  // Default: popup's LEFT edge sits at inputRect.left → grows rightward.
  const fitsRight = inputRect.left + popupW <= vw - m;
  // Flipped: popup's RIGHT edge sits at inputRect.right → grows leftward.
  const fitsLeft = inputRect.right - popupW >= m;

  const fitsBelow = inputRect.bottom + popupH <= vh - m;
  const fitsAbove = inputRect.top - popupH >= m;

  return {
    horizontal: fitsRight ? 'left' : fitsLeft ? 'right' : 'left',
    vertical: fitsBelow ? 'below' : fitsAbove ? 'above' : 'below',
  };
}
