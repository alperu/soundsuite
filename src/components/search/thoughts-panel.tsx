'use client';

import React, { useEffect, useRef, useState } from 'react';

/**
 * Collapsible research trace shown above a deep-search answer.
 *
 * The content is intermediate work — evidence-gathering narration, model
 * reasoning, and anything the preamble splitter diverted off the front of the
 * synthesis output. It can contain raw retrieved excerpts, whose bracketed
 * citation lines and stray `#` characters react-markdown renders as broken
 * headings, so this deliberately renders as preformatted plain text.
 */
export function ThoughtsPanel({
  text,
  streaming = false,
  answerStarted = false,
}: {
  text: string;
  /** Trace is still being appended to. */
  streaming?: boolean;
  /** The answer has begun arriving — collapse and get out of the way. */
  answerStarted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const userToggled = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Open while thinking, collapse once the answer starts — unless the user has
  // expressed a preference, which always wins from that point on.
  useEffect(() => {
    if (userToggled.current) return;
    if (streaming && !answerStarted) setOpen(true);
    else if (answerStarted || !streaming) setOpen(false);
  }, [streaming, answerStarted]);

  // Follow the tail while it streams.
  useEffect(() => {
    if (!open || !streaming) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, open, streaming]);

  if (!text.trim()) return null;

  const lineCount = text.split('\n').length;

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200">
      <button
        type="button"
        onClick={() => { userToggled.current = true; setOpen(o => !o); }}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 rounded-lg transition-colors"
      >
        <svg
          className={`w-3 h-3 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-xs font-medium text-gray-500">Thoughts</span>
        <span className="text-[11px] text-gray-400">
          research trace · {lineCount.toLocaleString()} line{lineCount === 1 ? '' : 's'}
        </span>
        {streaming && !answerStarted && (
          <span className="text-[11px] text-gray-400 animate-pulse ml-auto">thinking…</span>
        )}
      </button>
      {open && (
        <div ref={scrollRef} className="max-h-80 overflow-auto px-3 pb-3">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-gray-500 m-0">
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}
