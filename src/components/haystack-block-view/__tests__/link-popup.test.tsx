import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { LinkPopup, type InboundLinkRow } from '../link-popup';

/**
 * The fan-in popup only appears when two or more refs point at one block, and
 * the live corpus has no such block yet — so this is where its behaviour is
 * pinned: per-row actions act on their own ref, and "delete all" cannot fire
 * without a confirmation step.
 */

const rows: InboundLinkRow[] = [
  { edgeId: 'e1', sourceKey: 'filing:a', sourceLabel: 'first source', slot: 'respondingTo' },
  { edgeId: 'e2', sourceKey: 'filing:b', sourceLabel: 'second source', slot: 'resolves' },
  { edgeId: 'e3', sourceKey: 'filing:c', sourceLabel: 'third source', slot: 'replyingTo' },
];

function renderPopup(handlers: Partial<{
  onGoTo: (key: string) => void;
  onDelete: (edgeId: string) => void;
  onDeleteAll: (edgeIds: string[]) => void;
  onClose: () => void;
}> = {}) {
  return render(
    <LinkPopup
      x={10}
      y={10}
      targetLabel="the motion"
      rows={rows}
      onGoTo={handlers.onGoTo ?? (() => {})}
      onDelete={handlers.onDelete ?? (() => {})}
      onDeleteAll={handlers.onDeleteAll ?? (() => {})}
      onClose={handlers.onClose ?? (() => {})}
    />,
  );
}

describe('LinkPopup', () => {
  it('lists every inbound ref with its slot, and says how many', () => {
    renderPopup();
    expect(screen.getByText('3 links point here')).toBeTruthy();
    expect(screen.getAllByText('Go to')).toHaveLength(3);
    expect(screen.getByText('respondingTo')).toBeTruthy();
    expect(screen.getByText('resolves')).toBeTruthy();
  });

  it('acts on the row that was clicked, not the first one', () => {
    const deleted: string[] = [];
    const visited: string[] = [];
    renderPopup({ onDelete: id => deleted.push(id), onGoTo: key => visited.push(key) });
    fireEvent.click(screen.getAllByText('Delete')[1]);
    expect(deleted).toEqual(['e2']);
    renderPopup({ onDelete: id => deleted.push(id), onGoTo: key => visited.push(key) });
    fireEvent.click(screen.getAllByText('Go to')[2]);
    expect(visited).toEqual(['filing:c']);
  });

  it('will not delete everything without a confirmation step', () => {
    const wiped: string[][] = [];
    renderPopup({ onDeleteAll: ids => wiped.push(ids) });
    fireEvent.click(screen.getByText(/Delete all links/));
    // The first click only asks.
    expect(wiped).toHaveLength(0);
    expect(screen.getByText('Delete all 3?')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete all'));
    expect(wiped).toEqual([['e1', 'e2', 'e3']]);
  });

  it('backs out of the confirmation without deleting', () => {
    const wiped: string[][] = [];
    renderPopup({ onDeleteAll: ids => wiped.push(ids) });
    fireEvent.click(screen.getByText(/Delete all links/));
    fireEvent.click(screen.getByText('Cancel'));
    expect(wiped).toHaveLength(0);
    expect(screen.getByText(/Delete all links/)).toBeTruthy();
  });

  it('closes on Escape', () => {
    let closed = 0;
    renderPopup({ onClose: () => (closed += 1) });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(1);
  });
});
