/**
 * @jest-environment jsdom
 *
 * Regression test for the "search returns results once, then 0 matches" bug.
 *
 * Root cause: the submit path serialized the query from the chip-STRIPPED text
 * (`getText()` / the `aiQuery` mirror), so once a `{{ ... }}` mustache
 * materialized into a FilterChipNode the filter silently dropped out of the
 * query. The backend (segmentChipsAndIntents) only acts on inline `{{ raw }}`
 * markers, so the case filter vanished and the search returned 0 matches.
 *
 * The fix exposes `getComposerString()` on the ChipEditor handle, which emits
 * chips inline as `{{ raw }}` in SOURCE ORDER interleaved with free text. This
 * test renders the real editor, drives it through the handle, and asserts both
 * the serialized shape and that it round-trips through the backend splitter.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ChipEditor, type ChipEditorHandle } from '../chip-editor';
import { segmentChipsAndIntents } from '@/lib/search/chip-segments';
import type { FilterChip } from '@/lib/search/haystack-query-builder';

function mount(initialChips: FilterChip[], initialText = ''): {
  handle: ChipEditorHandle;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ref = React.createRef<ChipEditorHandle>();
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <ChipEditor ref={ref} initialChips={initialChips} initialText={initialText} />,
    );
  });
  if (!ref.current) throw new Error('ChipEditor handle did not initialize');
  return {
    handle: ref.current,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ChipEditor.getComposerString — submit serialization', () => {
  it('emits a single expression chip inline as {{ raw }}', () => {
    const { handle, unmount } = mount([{ kind: 'expression', raw: 'case==@abc' }]);
    expect(handle.getComposerString()).toBe('{{ case==@abc }}');
    unmount();
  });

  it('keeps the OR-group chip in the query (the exact reported case)', () => {
    const raw =
      '(case==@04a8cd94-359c-4feb-be16-979592c3c235 or ' +
      'case==@92b9ad81-040a-4830-8686-7cccaad903a4 or ' +
      'case==@1535c622-8955-4669-8f29-884a4f2b31ea or ' +
      'case==@c608b81a-8479-4890-8670-0d0352c257d8)';
    const { handle, unmount } = mount(
      [{ kind: 'expression', raw }],
      'how trust evolved over time',
    );

    const composer = handle.getComposerString();
    expect(composer).toContain(`{{ ${raw} }}`);
    expect(composer).toContain('how trust evolved over time');

    // End-to-end: the backend splitter must recover the chip from the string.
    const segs = segmentChipsAndIntents(composer);
    const chip = segs.find((s) => s.kind === 'chip');
    expect(chip).toBeTruthy();
    expect((chip as { raw: string }).raw).toBe(raw);
    unmount();
  });

  it('preserves source order: chip pairs with the prose that follows it', () => {
    const { handle, unmount } = mount(
      [{ kind: 'expression', raw: 'filingRef==@b691' }],
      'torrez statement',
    );
    const segs = segmentChipsAndIntents(handle.getComposerString());
    const chip = segs.find((s) => s.kind === 'chip') as { raw: string; nextIntent: string };
    expect(chip.raw).toBe('filingRef==@b691');
    expect(chip.nextIntent).toBe('torrez statement');
    unmount();
  });

  it('falls back to plain prose when there are no chips', () => {
    const { handle, unmount } = mount([], 'how trust evolved over time');
    expect(handle.getComposerString()).toBe('how trust evolved over time');
    unmount();
  });

  it('getText() drops the chip — proving why submit must use getComposerString()', () => {
    const { handle, unmount } = mount(
      [{ kind: 'expression', raw: 'case==@abc' }],
      'find documents',
    );
    // The old submit path read getText(): the chip is gone → 0 matches.
    expect(handle.getText()).not.toContain('case==@abc');
    // The new submit path reads getComposerString(): the chip survives.
    expect(handle.getComposerString()).toContain('{{ case==@abc }}');
    unmount();
  });
});
