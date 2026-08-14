/**
 * Tests for HaystackPreviewGrid — the right-panel "Haystack" debug-visibility tab.
 *
 * NOTE: relies on @testing-library/react. If that (or its peer dep
 * @testing-library/dom) isn't installed, this suite is skipped — same
 * convention as marker-picker.test.tsx.
 */

import React from 'react';
import { HaystackPreviewGrid } from '../haystack-preview-grid';

 
let RTL: any;
try {
   
  RTL = require('@testing-library/react');
} catch {
  RTL = null;
}

const maybe = RTL ? describe : describe.skip;

const realFetch = global.fetch;

function mockFetchResponse(body: any, ok = true) {
  return jest.fn(() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(body),
    } as any),
  );
}

maybe('HaystackPreviewGrid', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it('renders empty state when filter is empty', () => {
    const { render, screen } = RTL;
    global.fetch = jest.fn() as any;
    render(<HaystackPreviewGrid filter="" />);
    expect(screen.getByText(/No filter compiled/i)).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('triggers a debounced fetch when filter changes and renders rows', async () => {
    const { render, screen, waitFor, act } = RTL;
    const fetchMock = mockFetchResponse({
      count: 2,
      table: 'Motion',
      filter: 'motion and judgeRef==@abc',
      rows: [
        { id: 'm1aaaaaa-bbbb', motionType: 'Demurrer', judgeRef: '@abc' },
        { id: 'm2cccccc-dddd', motionType: 'Summary Judgment', judgeRef: '@abc' },
      ],
    });
    global.fetch = fetchMock as any;

    render(<HaystackPreviewGrid filter="motion and judgeRef==@abc" />);

    // Before debounce
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(550);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const call = (fetchMock.mock.calls as any[])[0];
    expect(call[0]).toBe('/api/haystack/read-grid');
    const body = JSON.parse(call[1].body);
    expect(body.filter).toBe('motion and judgeRef==@abc');

    await waitFor(() => {
      expect(screen.getByTestId('hpg-count').textContent).toMatch(/2 records/);
    });
    expect(screen.getAllByTestId('hpg-row')).toHaveLength(2);
    expect(screen.getByText(/Demurrer/)).toBeTruthy();
  });

  it('renders the resolved SQL block when the server returns resolvedFilter', async () => {
    const { render, screen, waitFor, act } = RTL;
    const fetchMock = mockFetchResponse({
      count: 1,
      table: 'Document',
      filter: 'documentType=="order"',
      resolvedFilter: '"documentType" = \'order\'',
      rows: [{ id: 'd1', documentType: 'order' }],
      debug: { traversalCount: 0 },
    });
    global.fetch = fetchMock as any;
    render(<HaystackPreviewGrid filter="documentType==&quot;order&quot;" />);
    await act(async () => { jest.advanceTimersByTime(550); });
    await waitFor(() => {
      expect(screen.getByTestId('hpg-resolved')).toBeTruthy();
    });
    expect(screen.getByTestId('hpg-resolved').textContent).toMatch(/documentType/);
  });

  it('shows traversal zero-state when intermediateIds=0', async () => {
    const { render, screen, waitFor, act } = RTL;
    const fetchMock = mockFetchResponse({
      count: 0,
      table: 'Document',
      filter: 'case->judge->displayName=="Nobody"',
      resolvedFilter: '"caseId" IN (\'__no_match__\')',
      rows: [],
      debug: { traversalCount: 1, intermediateIds: 0 },
    });
    global.fetch = fetchMock as any;
    render(<HaystackPreviewGrid filter='case->judge->displayName=="Nobody"' />);
    await act(async () => { jest.advanceTimersByTime(550); });
    await waitFor(() => {
      expect(screen.getByTestId('hpg-zero').textContent).toMatch(/no matching case IDs/i);
    });
  });

  it('shows dropped-clauses zero-state when constraints could not be applied', async () => {
    const { render, screen, waitFor, act } = RTL;
    const fetchMock = mockFetchResponse({
      count: 0,
      table: 'Case',
      filter: 'volumeNumber==3',
      resolvedFilter: '1 = 1',
      rows: [],
      debug: { traversalCount: 0, droppedClauses: ["volume_number = '3'"] },
    });
    global.fetch = fetchMock as any;
    render(<HaystackPreviewGrid filter="volumeNumber==3" />);
    await act(async () => { jest.advanceTimersByTime(550); });
    await waitFor(() => {
      expect(screen.getByTestId('hpg-zero').textContent).toMatch(/constraints couldn't be applied/i);
    });
  });

  it('shows an error bar on a 500 response', async () => {
    const { render, screen, waitFor, act } = RTL;
    const fetchMock = mockFetchResponse({ error: 'Parse failure: unexpected token' }, false);
    global.fetch = fetchMock as any;

    render(<HaystackPreviewGrid filter="motion and bogus(" />);

    await act(async () => {
      jest.advanceTimersByTime(550);
    });

    await waitFor(() => {
      expect(screen.getByTestId('hpg-error').textContent).toMatch(/Parse failure/);
    });
  });
});
