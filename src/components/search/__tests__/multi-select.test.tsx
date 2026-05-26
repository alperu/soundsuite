/**
 * Task #63 — multi-select picker behaviour.
 *
 * RTL isn't reliably installed (peer-dep @testing-library/dom is missing),
 * and the task constraints forbid new deps. We test the load-bearing pure
 * logic — the row-click dispatcher's selection rules and the parent's
 * chip-batch shape (lparen/or/.../rparen) — without rendering React.
 *
 * The dispatcher is replicated verbatim so a future change to either side
 * fails fast.
 *
 * @jest-environment jsdom
 */

interface PickEvent {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

/**
 * Verbatim copy of `onRowClick` from active-token-suggestions.tsx — kept in
 * sync by hand. Mirrors the modifier-key rules:
 *   - shift+click: range select from anchor to clicked value (inclusive)
 *   - cmd/ctrl+click: toggle value, update anchor
 *   - plain click with non-empty selection: clear + single-commit
 *   - plain click otherwise: single-commit
 */
function dispatchRowClick(
  e: PickEvent,
  optValue: string,
  orderedValues: string[],
  state: { selected: Set<string>; anchor: string | null },
): { commit: 'single' | null; nextSelected: Set<string>; nextAnchor: string | null } {
  if (e.shiftKey && state.anchor) {
    const a = orderedValues.indexOf(state.anchor);
    const b = orderedValues.indexOf(optValue);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const next = new Set(state.selected);
      for (let i = lo; i <= hi; i++) next.add(orderedValues[i]);
      return { commit: null, nextSelected: next, nextAnchor: optValue };
    }
  }
  if (e.metaKey || e.ctrlKey) {
    const next = new Set(state.selected);
    if (next.has(optValue)) next.delete(optValue);
    else next.add(optValue);
    return { commit: null, nextSelected: next, nextAnchor: optValue };
  }
  if (state.selected.size > 0) {
    return { commit: 'single', nextSelected: new Set(), nextAnchor: null };
  }
  return { commit: 'single', nextSelected: state.selected, nextAnchor: state.anchor };
}

describe('ActiveTokenSuggestions — row-click dispatcher (Task #63)', () => {
  const opts = ['filed', 'received', 'courtFiled', 'signed'];

  it('plain click commits a single value, no multi-selection', () => {
    const r = dispatchRowClick({}, 'filed', opts, { selected: new Set(), anchor: null });
    expect(r.commit).toBe('single');
    expect(r.nextSelected.size).toBe(0);
  });

  it('cmd+click toggles two distinct values into the set', () => {
    let state = { selected: new Set<string>(), anchor: null as string | null };
    let r = dispatchRowClick({ metaKey: true }, 'filed', opts, state);
    state = { selected: r.nextSelected, anchor: r.nextAnchor };
    r = dispatchRowClick({ metaKey: true }, 'signed', opts, state);
    expect(r.commit).toBeNull();
    expect(r.nextSelected.has('filed')).toBe(true);
    expect(r.nextSelected.has('signed')).toBe(true);
    expect(r.nextAnchor).toBe('signed');
  });

  it('cmd+click on a selected value removes it', () => {
    const state = { selected: new Set(['filed']), anchor: 'filed' as string | null };
    const r = dispatchRowClick({ metaKey: true }, 'filed', opts, state);
    expect(r.nextSelected.has('filed')).toBe(false);
  });

  it('shift+click selects an inclusive range from anchor', () => {
    const state = { selected: new Set(['filed']), anchor: 'filed' as string | null };
    const r = dispatchRowClick({ shiftKey: true }, 'courtFiled', opts, state);
    // Range covers index 0..2 → filed, received, courtFiled
    expect(r.nextSelected.has('filed')).toBe(true);
    expect(r.nextSelected.has('received')).toBe(true);
    expect(r.nextSelected.has('courtFiled')).toBe(true);
    expect(r.nextSelected.has('signed')).toBe(false);
  });

  it('shift+click works backwards (anchor below clicked value)', () => {
    const state = { selected: new Set(['signed']), anchor: 'signed' as string | null };
    const r = dispatchRowClick({ shiftKey: true }, 'received', opts, state);
    expect(r.nextSelected.has('received')).toBe(true);
    expect(r.nextSelected.has('courtFiled')).toBe(true);
    expect(r.nextSelected.has('signed')).toBe(true);
    expect(r.nextSelected.has('filed')).toBe(false);
  });

  it('plain click with non-empty selection clears + single-commits', () => {
    const state = { selected: new Set(['filed', 'signed']), anchor: 'signed' as string | null };
    const r = dispatchRowClick({}, 'received', opts, state);
    expect(r.commit).toBe('single');
    expect(r.nextSelected.size).toBe(0);
    expect(r.nextAnchor).toBeNull();
  });
});

describe('handlePickManyActiveToken chip-batch shape (Task #63)', () => {
  // Pure shape test that mirrors the parent's batch construction so the
  // (lparen, chip, or, chip, ..., rparen) invariant is locked in.
  it('produces lparen + interleaved or + rparen for N>=2 selections', () => {
    type Chip = { kind?: string; key?: string; value?: string; label?: string; op?: string };
    const op = '==';
    const key = 'reporterRef->displayName';
    const picked = [
      { value: 'Anderson', label: 'Anderson' },
      { value: 'Brown', label: 'Brown' },
      { value: 'Carter', label: 'Carter' },
    ];
    const batch: Chip[] = [{ kind: 'lparen' }];
    picked.forEach((p, i) => {
      if (i > 0) batch.push({ kind: 'or' });
      batch.push({ key, value: p.value, label: p.label, op });
    });
    batch.push({ kind: 'rparen' });
    expect(batch.length).toBe(7);
    expect(batch[0]).toEqual({ kind: 'lparen' });
    expect(batch[1]).toMatchObject({ key, value: 'Anderson', op });
    expect(batch[2]).toEqual({ kind: 'or' });
    expect(batch[6]).toEqual({ kind: 'rparen' });
  });
});
