'use client';

/**
 * DenyReasonPopover — anchored popover (NOT a modal) for capturing why the
 * user denied a suggestion. Shows templated tags + optional free text, then
 * submits via the provided onSubmit callback.
 *
 * Per UX research (Grammarly, Notion AI), modals break flow in a chat-heavy
 * layout — a small anchored popover keeps the user in context.
 */

import { useEffect, useRef, useState } from 'react';
import { DENY_REASON_TAGS, type DenyReasonTagSlug } from '@/lib/draft/suggestion-types';

export interface DenyReasonPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  onSubmit: (tags: DenyReasonTagSlug[], freeText: string) => void;
  onCancel: () => void;
}

export function DenyReasonPopover({ open, anchorEl, onSubmit, onCancel }: DenyReasonPopoverProps) {
  const [selectedTags, setSelectedTags] = useState<Set<DenyReasonTagSlug>>(new Set());
  const [freeText, setFreeText] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Position the popover above the anchor button.
  useEffect(() => {
    if (!open || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const popoverWidth = 320;
    // Try to keep within the viewport.
    const left = Math.max(16, Math.min(window.innerWidth - popoverWidth - 16, rect.left + rect.width / 2 - popoverWidth / 2));
    const top = rect.bottom + window.scrollY + 8;
    setPosition({ top, left });
  }, [open, anchorEl]);

  // Reset state on open.
  useEffect(() => {
    if (open) {
      setSelectedTags(new Set());
      setFreeText('');
    }
  }, [open]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popoverRef.current && !popoverRef.current.contains(target) && anchorEl && !anchorEl.contains(target)) {
        onCancel();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open, anchorEl, onCancel]);

  const toggleTag = (slug: DenyReasonTagSlug) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const handleSubmit = () => {
    onSubmit(Array.from(selectedTags), freeText.trim());
  };

  if (!open || !position) return null;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Why are you denying this suggestion?"
      className="fixed z-50 w-80 rounded-lg border border-gray-200 bg-white p-3 shadow-xl"
      style={{ top: position.top, left: position.left }}
    >
      <div className="mb-2 text-xs font-semibold text-gray-700">Why are you denying this?</div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {DENY_REASON_TAGS.map((tag) => {
          const selected = selectedTags.has(tag.slug);
          return (
            <button
              key={tag.slug}
              type="button"
              onClick={() => toggleTag(tag.slug)}
              className={
                'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ' +
                (selected
                  ? 'border-purple-500 bg-purple-100 text-purple-800'
                  : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50')
              }
              aria-pressed={selected}
            >
              {tag.label}
            </button>
          );
        })}
      </div>
      <textarea
        value={freeText}
        onChange={(e) => setFreeText(e.target.value)}
        placeholder="Add more context (optional)"
        rows={2}
        className="mb-2 w-full resize-none rounded border border-gray-300 px-2 py-1.5 text-[12px] focus:border-purple-400 focus:outline-none"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-gray-300 px-3 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={selectedTags.size === 0 && freeText.trim().length === 0}
          className="rounded bg-purple-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          Submit
        </button>
      </div>
    </div>
  );
}
