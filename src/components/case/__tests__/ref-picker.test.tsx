/**
 * Smoke test for <RefPicker>.
 *
 * NOTE: relies on @testing-library/react. If that (or its peer dep
 * @testing-library/dom) isn't installed, this test will not run until
 * `npm i -D @testing-library/react @testing-library/dom` is added.
 * Task #6 spec says: leave-as-is in that case.
 */

import React from 'react';
import { __clearRefPickerCache, RefPicker } from '../ref-picker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RTL: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RTL = require('@testing-library/react');
} catch {
  RTL = null;
}

const maybe = RTL ? describe : describe.skip;

maybe('RefPicker', () => {
  const ROBERTS = { id: 'person-roberts', displayName: 'Hon. Roberts', barNumber: '12345' };
  const SMITH = { id: 'person-smith', displayName: 'Jane Smith', barNumber: '99999' };
  const DOE = { id: 'person-doe', displayName: 'John Doe', barNumber: '11111' };

  beforeEach(() => {
    __clearRefPickerCache();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ rows: [ROBERTS, SMITH, DOE] }),
      }) as unknown as Response,
    );
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).fetch;
  });

  it('filters results by typed query and emits @id on Enter', async () => {
    const { render, screen, fireEvent, waitFor } = RTL;
    const onChange = jest.fn();
    const onClose = jest.fn();

    render(
      <RefPicker
        refTarget="person"
        value={null}
        onChange={onChange}
        onClose={onClose}
      />,
    );

    const input = screen.getByPlaceholderText(/search person/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'rob' } });

    // wait for debounce + fetch
    await waitFor(() => {
      expect(screen.queryByText(/Hon\. Roberts/)).toBeTruthy();
    });

    // Smith should be filtered out client-side.
    expect(screen.queryByText(/Jane Smith/)).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('@person-roberts');
  });

  it('renders auth-warning fallback on 401', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () =>
      ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response,
    );
    const { render, screen, fireEvent, waitFor } = RTL;
    const onChange = jest.fn();
    const onClose = jest.fn();

    render(
      <RefPicker
        refTarget="person"
        value={null}
        onChange={onChange}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Haystack API unavailable/i)).toBeTruthy();
    });

    const input = screen.getByPlaceholderText(/@person-/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'manually-typed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('@manually-typed');
  });
});
