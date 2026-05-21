/**
 * Smoke test for <MotionTypePicker>.
 *
 * NOTE: relies on @testing-library/react. If that (or its peer dep
 * @testing-library/dom) isn't installed, this suite is skipped.
 * Same convention as marker-picker.test.tsx / ref-picker.test.tsx.
 */

import React from 'react';
import { MotionTypePicker } from '../motion-type-picker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RTL: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RTL = require('@testing-library/react');
} catch {
  RTL = null;
}

const maybe = RTL ? describe : describe.skip;

maybe('MotionTypePicker', () => {
  afterEach(() => {
    if (RTL) RTL.cleanup();
  });

  it('renders displayName in read mode for a known slug', () => {
    const { getByText } = RTL.render(
      <MotionTypePicker value="disqualify" editable={false} onChange={() => {}} />,
    );
    expect(getByText('Motion to Disqualify')).toBeTruthy();
  });

  it('filters results as the user types', () => {
    const onChange = jest.fn();
    const { getByPlaceholderText, queryByText } = RTL.render(
      <MotionTypePicker value={null} editable onChange={onChange} />,
    );
    const input = getByPlaceholderText(/Pick a type/i);
    RTL.fireEvent.focus(input);
    RTL.fireEvent.change(input, { target: { value: 'disq' } });
    expect(queryByText('Motion to Disqualify')).toBeTruthy();
    // Non-matching entries hidden.
    expect(queryByText('Motion to Compel')).toBeNull();
  });

  it('Enter on a highlighted catalog entry commits its slug', () => {
    const onChange = jest.fn();
    const { getByPlaceholderText } = RTL.render(
      <MotionTypePicker value={null} editable onChange={onChange} />,
    );
    const input = getByPlaceholderText(/Pick a type/i);
    RTL.fireEvent.focus(input);
    RTL.fireEvent.change(input, { target: { value: 'disq' } });
    // Highlight defaults to 0 → first prefix match = Motion to Disqualify
    RTL.fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('disqualify');
  });

  it('Enter on free-text (no match) commits the typed string', () => {
    const onChange = jest.fn();
    const { getByPlaceholderText } = RTL.render(
      <MotionTypePicker value={null} editable allowFreeText onChange={onChange} />,
    );
    const input = getByPlaceholderText(/Pick a type/i);
    RTL.fireEvent.focus(input);
    RTL.fireEvent.change(input, { target: { value: 'novelMotion' } });
    // Highlight defaults to 0. With zero catalog results, the only row
    // is the free-text sticky row at index 0.
    RTL.fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('novelMotion');
  });
});
