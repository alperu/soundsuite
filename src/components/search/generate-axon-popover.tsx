'use client';

/**
 * GenerateAxonPopover — composer-mounted entry point for the
 * English-to-Axon generator. Mirrors the left-rail `GenerateAxonBox`
 * (see sample-query-panel.tsx) but is anchored inline to the new
 * `{{ }}` mustache composer in search-interface.tsx.
 *
 * Flow:
 *   1. User clicks the "✨ from English" trigger pill (rendered next
 *      to Deep/RLM/Compare/Filter in the composer's bottom-left).
 *   2. A small popover opens above the trigger with a textarea +
 *      Generate button.
 *   3. On success we call `onInsert(axon)` — the parent splices the
 *      result into the textarea wrapped in `{{ }}` so the mustache
 *      extractor in search-interface.tsx materialises chips on the
 *      next render cycle.
 *
 * API contract (confirmed against
 * src/app/api/search/axon-generate/route.ts):
 *   POST /api/search/axon-generate
 *   body:    { english: string }   (1..500 chars after trim)
 *   200 ok:  { ok: true, axon: string }
 *   200/4xx: { ok: false, error: string }
 *
 * The popover does NOT include positioning libs — it's an absolutely
 * positioned panel anchored above its trigger with a wrapping <div>.
 */

import React, { useEffect, useRef, useState } from 'react';

export interface GenerateAxonPopoverProps {
  /** Called with the raw axon string returned from the API. */
  onInsert: (axon: string) => void;
  /**
   * Renders nothing when false (e.g. when the Filter toggle is off and
   * the result wouldn't materialise as chips). Parent decides.
   */
  disabled?: boolean;
}

export function GenerateAxonPopover({ onInsert, disabled }: GenerateAxonPopoverProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const submitDisabled = !trimmed || loading;

  // Auto-focus the input when the popover opens.
  useEffect(() => {
    if (open) {
      // Defer to next frame so the element is mounted.
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const handleGenerate = async () => {
    if (submitDisabled) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/search/axon-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ english: trimmed }),
      });
      let data: { ok?: boolean; axon?: string; error?: string } = {};
      try {
        data = await res.json();
      } catch {
        /* handled below */
      }
      if (!res.ok || !data?.ok || typeof data.axon !== 'string') {
        setError(data?.error || `Request failed (${res.status})`);
        return;
      }
      onInsert(data.axon);
      setText('');
      setOpen(false);
    } catch (e) {
      setError((e as Error).message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleGenerate();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleGenerate();
    }
  };

  if (disabled) return null;

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors inline-flex items-center gap-1 ${
          open ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
        }`}
        title="Generate filter from a plain-English description"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span aria-hidden="true">✨</span>
        <span>from English</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Generate filter from English"
          className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border border-gray-200 bg-white shadow-lg p-3 z-50"
        >
          <label
            htmlFor="composer-axon-generate-input"
            className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1"
          >
            Describe what to find
          </label>
          <textarea
            id="composer-axon-generate-input"
            ref={textareaRef}
            rows={2}
            maxLength={500}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="e.g. motions filed by Judge Roberts in April 2026"
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-none bg-white"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] text-gray-400">{text.length}/500</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-2 py-1 text-[11px] text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={submitDisabled}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-purple-600 text-white hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                {loading && (
                  <svg
                    className="animate-spin h-3 w-3 text-white"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                )}
                Generate
              </button>
            </div>
          </div>
          {error && (
            <div
              role="alert"
              className="mt-1.5 text-[10px] text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-1 break-words"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
