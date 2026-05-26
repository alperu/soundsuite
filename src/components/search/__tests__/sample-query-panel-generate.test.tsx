/**
 * @jest-environment jsdom
 *
 * Tests for the "Generate Axon" box at the top of SampleQueryPanel (task #70).
 *
 * Convention follows haystack-preview-grid.test.tsx: skip the whole suite if
 * @testing-library/react isn't installed in the dev environment.
 */

import React from 'react';
import { SampleQueryPanel } from '../sample-query-panel';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RTL: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RTL = require('@testing-library/react');
} catch {
  RTL = null;
}

const maybe = RTL ? describe : describe.skip;

const realFetch = global.fetch;

maybe('SampleQueryPanel — Generate Axon box', () => {
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('disables the Generate button when the textarea is empty', () => {
    const { render, screen } = RTL;
    render(
      <SampleQueryPanel onSelectQuery={jest.fn()} onSelectToken={jest.fn()} />,
    );
    const btn = screen.getByRole('button', { name: /generate axon/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('POSTs to /api/search/axon-generate and forwards the axon to onSelectQuery', async () => {
    const { render, screen, fireEvent, waitFor } = RTL;
    const axon = 'motion and motionType=="disqualification"';
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, axon }),
      } as any),
    ) as any;

    const onSelectQuery = jest.fn();
    render(
      <SampleQueryPanel onSelectQuery={onSelectQuery} onSelectToken={jest.fn()} />,
    );

    const textarea = screen.getByLabelText(/generate from english/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'all disqualification motions' } });

    const btn = screen.getByRole('button', { name: /generate axon/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/search/axon-generate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ english: 'all disqualification motions' });

    await waitFor(() => expect(onSelectQuery).toHaveBeenCalledTimes(1));
    const arg = onSelectQuery.mock.calls[0][0];
    expect(arg.englishPrompt).toBe(axon);
    expect(arg.compiledFilter).toBe(axon);

    // Textarea cleared on success.
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it('shows an inline error pill when the API returns {ok:false}', async () => {
    const { render, screen, fireEvent, waitFor } = RTL;
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: false, error: 'Could not generate a valid Axon query.' }),
      } as any),
    ) as any;

    const onSelectQuery = jest.fn();
    render(
      <SampleQueryPanel onSelectQuery={onSelectQuery} onSelectToken={jest.fn()} />,
    );

    const textarea = screen.getByLabelText(/generate from english/i);
    fireEvent.change(textarea, { target: { value: 'gibberish' } });
    fireEvent.click(screen.getByRole('button', { name: /generate axon/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/could not generate/i);
    expect(onSelectQuery).not.toHaveBeenCalled();
  });
});
