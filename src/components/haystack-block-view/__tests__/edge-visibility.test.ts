import { edgeVisibility, type EdgeVisibilityInput } from '../edge-visibility';

/**
 * Four things can reveal an edge and they were added one at a time (#60, #67,
 * #75, #91). What matters is not each rule but their ORDER — which is why the
 * precedence is a pure function and these tests read it back.
 */

const base: EdgeVisibilityInput = {
  isContains: false,
  endpoints: ['filing:a', 'filing:b'],
  editMode: true,
  hovered: null,
  pinned: null,
  selected: new Set(),
  showAll: false,
  draggingCaseRef: false,
};

const at = (over: Partial<EdgeVisibilityInput>) => edgeVisibility({ ...base, ...over });

describe('edgeVisibility', () => {
  it('draws nothing at rest', () => {
    expect(at({}).visible).toBe(false);
    expect(at({ isContains: true }).visible).toBe(false);
  });

  it('keeps a selected block\'s edges up, at full strength and clickable', () => {
    const shown = at({ selected: new Set(['filing:a']) });
    expect(shown).toEqual({ visible: true, opacity: 1, state: 'selected', interactive: true });
    // Either end counts — an edge belongs to both blocks it joins.
    expect(at({ selected: new Set(['filing:b']) }).visible).toBe(true);
    // And containment is included: selecting a block shows its case link too.
    expect(at({ isContains: true, selected: new Set(['filing:a']) }).state).toBe('selected');
  });

  it('treats a pin exactly as a selection — that is what a pin is for', () => {
    expect(at({ pinned: 'filing:a' }).state).toBe('selected');
  });

  it('shows the union under a multi-select, and nothing for unrelated blocks', () => {
    const selected = new Set(['filing:a', 'filing:z']);
    expect(at({ selected }).visible).toBe(true);
    expect(at({ selected, endpoints: ['filing:x', 'filing:y'] }).visible).toBe(false);
  });

  it('ranks selection above hover, so a moving pointer cannot dim the work', () => {
    // Hovering somewhere else while a block is selected: the selected block's
    // edges must not drop to the hover treatment.
    const shown = at({ selected: new Set(['filing:a']), hovered: 'filing:q' });
    expect(shown.state).toBe('selected');
    expect(shown.opacity).toBe(1);
  });

  it('ranks hover above the show-all backdrop', () => {
    const shown = at({ hovered: 'filing:a', showAll: true });
    expect(shown.state).toBe('hovered');
    expect(shown.opacity).toBe(1);
  });

  it('reveals the fan while a caseRef link is being drawn, in edit mode only', () => {
    expect(at({ isContains: true, draggingCaseRef: true }).state).toBe('authoring');
    expect(at({ isContains: true, draggingCaseRef: true, editMode: false }).visible).toBe(false);
  });

  it('draws show-all as a backdrop, with the fan quieter than the refs', () => {
    const ref = at({ showAll: true });
    const fan = at({ isContains: true, showAll: true });
    expect(ref.state).toBe('show-all');
    expect(fan.opacity).toBeLessThan(ref.opacity);
  });

  it('never lets an authoring reveal intercept the pointer', () => {
    // The fan during a drag is scenery for the gesture in progress; taking
    // clicks would put it in the way of the drop it exists to guide.
    expect(at({ isContains: true, draggingCaseRef: true }).interactive).toBe(false);
  });
});
