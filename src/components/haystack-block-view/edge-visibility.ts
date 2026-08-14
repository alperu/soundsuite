/**
 * When an edge draws itself, and how loudly.
 *
 * Three things can ask for a line — a pointer passing over a block, a
 * deliberate selection or pin, and the "show all" preference — and they arrived
 * one at a time (#60, #67, #75, #91). Spread across a component that also
 * renders, their interaction was impossible to read and impossible to test.
 * This is the whole rule in one pure function.
 *
 * PRECEDENCE, strongest first:
 *   1. SELECTED / PINNED — the user pointed at this block and is working on it.
 *      Every edge it owns stays up, at full strength, until they say otherwise.
 *      This is the state that makes a line clickable long enough to delete.
 *   2. HOVERED — the same reveal, but transient: it follows the pointer.
 *   3. DRAGGING a caseRef — the containment fan is the authoring affordance for
 *      that gesture, so it appears for the duration.
 *   4. SHOW ALL — the standing preference. Weakest, and drawn faintest, because
 *      it is a backdrop rather than an answer to a question.
 * Nothing else draws an edge.
 */

export interface EdgeVisibilityInput {
  /** Containment edges are the case fan; everything else is a ref. */
  isContains: boolean;
  /** The two block keys this edge joins. */
  endpoints: readonly string[];
  /** Filtering mode never authors containment, so it never reveals the fan. */
  editMode: boolean;
  hovered: string | null;
  pinned: string | null;
  /** Blocks the user has selected — one in the editor, many under a marquee. */
  selected: ReadonlySet<string>;
  showAll: boolean;
  /** A caseRef link being dragged: the fan is what the user is aiming at. */
  draggingCaseRef: boolean;
}

export interface EdgeVisibility {
  visible: boolean;
  opacity: number;
  /** What the DOM reports, so tests and the assertion script can see WHY. */
  state: 'hidden' | 'selected' | 'hovered' | 'authoring' | 'show-all';
  /** Only a deliberately revealed edge takes pointer events — a backdrop line
   *  must not intercept clicks meant for the blocks under it. */
  interactive: boolean;
}

const HIDDEN: EdgeVisibility = {
  visible: false,
  opacity: 0,
  state: 'hidden',
  interactive: false,
};

export function edgeVisibility(input: EdgeVisibilityInput): EdgeVisibility {
  const { endpoints } = input;
  const touches = (key: string | null) => key !== null && endpoints.includes(key);
  const isSelected = endpoints.some(key => input.selected.has(key)) || touches(input.pinned);

  if (isSelected) {
    return { visible: true, opacity: 1, state: 'selected', interactive: true };
  }
  if (touches(input.hovered)) {
    // Containment stays quieter than a ref even when revealed: on a hovered
    // block the ref chain is the answer and the case link is context.
    return {
      visible: true,
      opacity: input.isContains ? 0.55 : 1,
      state: 'hovered',
      interactive: true,
    };
  }
  if (input.isContains && input.editMode && input.draggingCaseRef) {
    return { visible: true, opacity: 0.55, state: 'authoring', interactive: false };
  }
  if (input.showAll) {
    return {
      visible: true,
      // The fan is ~88 of ~90 lines; at ref weight it buries what it surrounds.
      opacity: input.isContains ? 0.3 : 0.45,
      state: 'show-all',
      interactive: true,
    };
  }
  return HIDDEN;
}
