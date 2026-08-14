/**
 * Smoke test for <MarkerPicker>.
 *
 * NOTE: relies on @testing-library/react. If that (or its peer dep
 * @testing-library/dom) isn't installed, this suite is skipped.
 * Same convention as ref-picker.test.tsx.
 */

import React from 'react';
import { MarkerPicker } from '../marker-picker';
import type { TagSpec } from '../tag-spec';

 
let RTL: any;
try {
   
  RTL = require('@testing-library/react');
} catch {
  RTL = null;
}

const maybe = RTL ? describe : describe.skip;

const AVAILABLE: TagSpec[] = [
  { name: 'motion', tier: 'marker', doc: 'a motion' },
  { name: 'signed', tier: 'marker', doc: 'judge signed' },
  { name: 'appellate', tier: 'marker', doc: 'appellate level' },
];

maybe('MarkerPicker', () => {
  it('filters by typed query (hiding current markers) and adds on Enter', () => {
    const { render, screen, fireEvent } = RTL;
    const onAdd = jest.fn();

    render(
      <MarkerPicker
        available={AVAILABLE}
        current={new Set(['motion'])}
        onAdd={onAdd}
      />,
    );

    const input = screen.getByPlaceholderText(/add marker/i) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 's' } });

    // 'signed' matches; 'motion' is hidden (already current);
    // 'appellate' has no 's', so it should also not appear.
    expect(screen.queryByText('signed')).toBeTruthy();
    expect(screen.queryByText('motion')).toBeNull();
    expect(screen.queryByText('appellate')).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('signed');
  });
});
