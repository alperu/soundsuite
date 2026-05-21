/**
 * Smoke test for ExtractModal.
 * Verifies state A renders the picker tabs, and state C renders candidate
 * cards with the expected intrinsic-marker chip toggles.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ExtractModal } from '../extract-modal';
import type { ExtractCandidate } from '../extract-types';

// Stub fetch so the typeahead doesn't blow up.
beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ documents: [] }),
    }),
  ) as unknown as jest.Mock;
});

afterEach(() => {
  jest.resetAllMocks();
});

describe('ExtractModal', () => {
  it('renders picker tabs in state A (picking)', () => {
    render(
      <ExtractModal
        open
        onClose={() => {}}
        onConfirmed={() => {}}
      />,
    );

    expect(
      screen.getByRole('dialog', { name: /extract personas/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /from ingested document/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /upload new pdf/i })).toBeInTheDocument();
    // Hint text
    expect(
      screen.getByText(/we'll scan the file for attorneys/i),
    ).toBeInTheDocument();
  });

  it('renders nothing when open=false', () => {
    const { container } = render(
      <ExtractModal
        open={false}
        onClose={() => {}}
        onConfirmed={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders candidate cards in state C (reviewing) with intrinsic chip toggles', () => {
    const candidates: ExtractCandidate[] = [
      {
        id: 'c1',
        displayName: 'Jane Smith',
        barNumber: 'TX-99887766',
        email: 'jane@example.com',
        intrinsicTags: ['lawyer'],
        sourceQuote: 'Attorney for Plaintiff, Jane Smith, Bar No. TX-99887766',
        dedupMatches: [
          {
            personaId: 'p1',
            displayName: 'Jane Smith',
            score: 0.85,
            matchReason: 'bar number match',
          },
        ],
        proposedRole: {
          scopeKind: 'motion',
          scopeId: 'm1',
          scopeLabel: 'Cause 12345 / MTD',
          contextualTags: ['movant'],
        },
        confirmed: true,
      },
      {
        id: 'c2',
        displayName: 'Hon. R. Roberts',
        intrinsicTags: ['judge'],
        dedupMatches: [],
        confirmed: true,
      },
    ];

    render(
      <ExtractModal
        open
        onClose={() => {}}
        onConfirmed={() => {}}
        defaultState="reviewing"
        defaultCandidates={candidates}
      />,
    );

    // Both cards rendered
    const cards = screen.getAllByTestId('extract-candidate-card');
    expect(cards).toHaveLength(2);

    // Display names visible (as input values)
    expect(screen.getByDisplayValue('Jane Smith')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Hon. R. Roberts')).toBeInTheDocument();

    // Intrinsic chip on first card: lawyer pressed
    const firstCardChips = cards[0].querySelector('[data-testid="intrinsic-chips"]')!;
    const lawyerChip = firstCardChips.querySelector('[data-tag="lawyer"]');
    expect(lawyerChip).toHaveAttribute('aria-pressed', 'true');
    const judgeChip = firstCardChips.querySelector('[data-tag="judge"]');
    expect(judgeChip).toHaveAttribute('aria-pressed', 'false');

    // Second card: judge pressed
    const secondCardChips = cards[1].querySelector('[data-testid="intrinsic-chips"]')!;
    expect(secondCardChips.querySelector('[data-tag="judge"]'))
      .toHaveAttribute('aria-pressed', 'true');

    // Footer confirms count
    expect(screen.getByRole('button', { name: /confirm all \(2\)/i })).toBeInTheDocument();
  });
});
