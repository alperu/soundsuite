// The jest transform uses the classic JSX runtime, so the React binding has to
// be in scope by name — every component suite in this repo imports it.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { LinkPicker } from '../link-picker';
import { buildScopeGraph, filingKey } from '../scope-graph';
import type { LinkPlan } from '../link-rules';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * The picker has no entry point yet (#62d opens it from a menu, #63c from a
 * slot click), so these tests are what proves it works. They check the two
 * things a wrong picker would get wrong: offering a row that a drop would
 * refuse, and handing back something other than the plan it displayed.
 */

function filing(
  id: string,
  primaryKind: string,
  refs: Record<string, string> = {},
  filingDate: string | null = null,
): ScopeFiling {
  return {
    id,
    filingType: primaryKind,
    label: `filing ${id}`,
    docCount: 0,
    indexedCount: 0,
    refs,
    documents: [],
    entityKinds: [primaryKind],
    primaryKind,
    filingDate,
  };
}

function testCase(id: string, filings: ScopeFiling[]): ScopeCase {
  return { id, name: `case ${id}`, filings, unfiledDocCount: 0, unfiledIndexedCount: 0 };
}

const graph = buildScopeGraph([
  testCase('c1', [
    filing('m1', 'motion', {}, '2026-02-01T00:00:00.000Z'),
    filing('m2', 'motion', {}, '2026-01-01T00:00:00.000Z'),
    filing('r1', 'response'),
    filing('o1', 'order'),
  ]),
  testCase('c2', [filing('m3', 'motion', {}, '2026-03-01T00:00:00.000Z')]),
]);

const anchorRect = {
  left: 100,
  right: 120,
  top: 100,
  bottom: 120,
  width: 20,
  height: 20,
  x: 100,
  y: 100,
  toJSON: () => ({}),
} as DOMRect;

function renderPicker(onPick: (plan: LinkPlan) => void = () => {}) {
  return render(
    <LinkPicker
      graph={graph}
      sourceKey={filingKey('r1')}
      slot="respondingTo"
      side="output"
      anchorRect={anchorRect}
      onPick={onPick}
      onClose={() => {}}
    />,
  );
}

describe('LinkPicker', () => {
  it('lists only what the rules would accept, and says how many', () => {
    renderPicker();
    const rows = screen.getAllByRole('button');
    // Three motions can take a respondingTo; the order and the case blocks
    // cannot, so they are absent rather than greyed.
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.getAttribute('data-row-enabled') === 'yes')).toBe(true);
    expect(screen.getByText(/3 can take this link/)).toBeTruthy();
  });

  it('puts the same case first, then docket order', () => {
    renderPicker();
    const keys = screen.getAllByRole('button').map(r => r.getAttribute('data-link-row'));
    // m2 (Jan) before m1 (Feb), both ahead of the other case's m3 despite its
    // date being latest — same case wins before date is consulted.
    expect(keys).toEqual([filingKey('m2'), filingKey('m1'), filingKey('m3')]);
  });

  it('hands back the PLAN it showed, not a target id', () => {
    const picked: LinkPlan[] = [];
    renderPicker(plan => picked.push(plan));
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(picked).toHaveLength(1);
    expect(picked[0].type).toBe('ref');
    if (picked[0].type === 'ref') {
      expect(picked[0].slot).toBe('respondingTo');
      expect(picked[0].targetId).toBe('m2');
    }
  });

  it('reveals a refused row only when the search finds it, with its reason', () => {
    renderPicker();
    // Absent while browsing…
    expect(screen.queryByText(/filing o1/)).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'o1' } });
    const row = screen.getByText(/filing o1/).closest('button');
    expect(row?.getAttribute('data-row-enabled')).toBe('no');
    expect(row?.getAttribute('title')).toMatch(/motion/i);
  });

  it('Enter links the highlighted row', () => {
    const picked: LinkPlan[] = [];
    renderPicker(plan => picked.push(plan));
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(picked).toHaveLength(1);
    if (picked[0].type === 'ref') expect(picked[0].targetId).toBe('m1');
  });
});
