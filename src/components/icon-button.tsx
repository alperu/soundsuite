'use client';

import {
  forwardRef,
  useCallback,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

/**
 * IconButton — icon-only button with a styled hover/focus tooltip.
 *
 * The native `title` attribute renders slowly (~700 ms delay) and looks
 * inconsistent across OSes; this primitive replaces it with a Tailwind-styled
 * span positioned below the button on hover/focus. The `tooltip` prop is also
 * mirrored to `aria-label` so screen readers continue to announce the action.
 *
 * Edge-awareness: on hover-in we measure the centered tooltip's bounding rect
 * against the viewport. If it would clip the right edge we anchor the tooltip
 * to the right of the button; if it would clip the left, we anchor it to the
 * left. Pure CSS centering can't do this — so we toggle a state-driven class.
 *
 * Usage:
 *   <IconButton tooltip="Edit Filing" onClick={…}>
 *     <svg … />
 *   </IconButton>
 */
export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  tooltip: string;
  /** Tooltip placement. Defaults to "bottom"; use "top" for buttons close to the bottom edge of a scroll container. */
  placement?: 'top' | 'bottom';
  children: ReactNode;
}

type Align = 'center' | 'left' | 'right';

const ALIGN_CLASS: Record<Align, string> = {
  center: 'left-1/2 -translate-x-1/2',
  // Anchor the tooltip's LEFT edge to the button's LEFT edge.
  left: 'left-0 translate-x-0',
  // Anchor the tooltip's RIGHT edge to the button's RIGHT edge.
  right: 'right-0 left-auto translate-x-0',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { tooltip, placement = 'bottom', className, children, onMouseEnter, onFocus, ...rest },
    ref,
  ) {
    const pos =
      placement === 'top'
        ? 'bottom-full mb-1.5'
        : 'top-full mt-1.5';
    const tipRef = useRef<HTMLSpanElement | null>(null);
    const [align, setAlign] = useState<Align>('center');

    // Re-measure on every hover/focus so the alignment is correct even when
    // the layout has shifted (panels opening, viewport resize, etc.). Cheap —
    // a single getBoundingClientRect call per show event.
    //
    // Boundary detection: the tooltip should stay inside the BUTTON's nearest
    // positioned/flex ancestor — not just the viewport. On the filing page
    // the toolbar sits alongside a right rail panel; using viewport width
    // would let the tooltip slide UNDER the rail. We walk up to the closest
    // ancestor whose right edge differs from the viewport (i.e. a real
    // container, not a full-bleed wrapper) and use its right edge as the
    // boundary. Falls back to the viewport on top-level buttons.
    // IMPORTANT: compute geometry analytically from the BUTTON's rect, not
    // from the tooltip's live rect. The live rect depends on current `align`
    // state — measuring it would oscillate: a right-aligned tooltip doesn't
    // overflow → we'd flip back to center → it overflows again → flip right…
    // Using the button position + tooltip width gives a stable answer
    // regardless of whichever side the tooltip is currently anchored to.
    const recomputeAlign = useCallback(() => {
      const el = tipRef.current;
      const wrapper = el?.parentElement;
      const btn = wrapper?.querySelector('button');
      if (!el || !wrapper || !btn) return;
      requestAnimationFrame(() => {
        const tipWidth = el.getBoundingClientRect().width;
        const btnRect = btn.getBoundingClientRect();
        const btnCenter = (btnRect.left + btnRect.right) / 2;
        const naturalLeft = btnCenter - tipWidth / 2;
        const naturalRight = btnCenter + tipWidth / 2;

        const PAD = 8;
        const vw = window.innerWidth;

        // Boundary = nearest scrolling ancestor. On split-pane layouts
        // (filing page: main content + right rail) this naturally stops at
        // the gutter between panes, so the tooltip won't slide under the
        // sibling panel. Falls back to the viewport if no scroll-container
        // is found.
        let rightBoundary = vw - PAD;
        let leftBoundary = PAD;
        let cur: HTMLElement | null = wrapper.parentElement;
        for (let i = 0; i < 10 && cur; i++) {
          const cs = window.getComputedStyle(cur);
          const scrolls =
            cs.overflow === 'auto' || cs.overflow === 'scroll' || cs.overflow === 'hidden' ||
            cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'hidden' ||
            cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'hidden';
          if (scrolls) {
            const r = cur.getBoundingClientRect();
            if (r.right + PAD < vw) rightBoundary = r.right - PAD;
            if (r.left - PAD > 0) leftBoundary = r.left + PAD;
            break;
          }
          cur = cur.parentElement;
        }

        const overflowsRight = naturalRight > rightBoundary;
        const overflowsLeft = naturalLeft < leftBoundary;
        let next: Align = 'center';
        if (overflowsRight && !overflowsLeft) next = 'right';
        else if (overflowsLeft && !overflowsRight) next = 'left';
        // If both edges overflow there's no good direction — center is
        // still the least-bad option (tooltip will clip on both sides equally).
        setAlign((prev) => (prev === next ? prev : next));
      });
    }, []);

    const handleMouseEnter: ButtonHTMLAttributes<HTMLButtonElement>['onMouseEnter'] = (e) => {
      recomputeAlign();
      onMouseEnter?.(e);
    };
    const handleFocus: ButtonHTMLAttributes<HTMLButtonElement>['onFocus'] = (e) => {
      recomputeAlign();
      onFocus?.(e);
    };

    return (
      <span className="relative inline-flex group">
        <button
          ref={ref}
          aria-label={tooltip}
          className={className}
          onMouseEnter={handleMouseEnter}
          onFocus={handleFocus}
          {...rest}
        >
          {children}
        </button>
        {/*
          Hover-IN has a 150 ms delay so the tooltip doesn't flicker when the
          mouse just brushes past. Hover-OUT must be immediate so the tip
          doesn't linger after the cursor leaves (and especially so it
          disappears the moment the user hovers a sibling icon button).
          Achieved with `delay-0` at rest + `group-hover:delay-150` on the
          show state — Tailwind only re-applies the longer delay during hover.
          Horizontal alignment is state-driven (see ALIGN_CLASS) so the
          tooltip flips toward the available side when it would overflow.
        */}
        <span
          ref={tipRef}
          role="tooltip"
          className={`pointer-events-none absolute ${ALIGN_CLASS[align]} ${pos} w-max max-w-[16rem] px-2 py-1 rounded bg-gray-900 text-white text-[11px] leading-snug text-center shadow-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-100 delay-0 group-hover:delay-150 group-focus-within:delay-150 z-50`}
        >
          {tooltip}
        </span>
      </span>
    );
  },
);
