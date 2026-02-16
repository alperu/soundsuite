'use client';

import { useEffect, useRef } from 'react';

export interface AIProgressEntry {
  type: 'progress';
  step: string;
  message: string;
  timestamp: number;
  detail?: {
    vectorHits?: number;
    searchMode?: string;
    keywords?: string[];
    patternHits?: number;
    newChunksAdded?: number;
    totalSources?: number;
    usedSources?: number;
    contextChars?: number;
    topCitations?: string[];
    provider?: string;
    model?: string;
  };
}

interface AIThinkingLogProps {
  entries: AIProgressEntry[];
  expanded: boolean;
  onToggle: () => void;
  startTime: number;
  loading: boolean;
}

export function AIThinkingLog({ entries, expanded, onToggle, startTime, loading }: AIThinkingLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length, expanded]);

  // Live elapsed timer
  useEffect(() => {
    if (!loading || !elapsedRef.current) return;
    const tick = () => {
      if (elapsedRef.current) {
        const s = ((Date.now() - startTime) / 1000).toFixed(1);
        elapsedRef.current.textContent = `${s}s`;
      }
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [loading, startTime]);

  const lastEntry = entries[entries.length - 1];
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-purple-200 overflow-hidden text-sm">
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-purple-50 border-b border-purple-100 hover:bg-purple-100 transition-colors"
      >
        <svg
          className={`w-3.5 h-3.5 text-purple-500 transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        {loading ? (
          <>
            <svg className="w-3.5 h-3.5 text-purple-500 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-purple-700 font-medium">Thinking...</span>
            <span ref={elapsedRef} className="ml-auto text-xs text-purple-400 tabular-nums">{elapsed}s</span>
          </>
        ) : (
          <>
            <span className="text-purple-600 font-medium">Thought for {elapsed}s</span>
            <span className="ml-auto text-xs text-purple-400">{entries.length} steps</span>
          </>
        )}
      </button>

      {/* Entries */}
      {expanded && (
        <div ref={scrollRef} className="max-h-56 overflow-y-auto px-4 py-2 space-y-1.5">
          {entries.map((entry, i) => {
            const isLast = i === entries.length - 1;
            const isActive = isLast && loading;
            const relTime = ((entry.timestamp - startTime) / 1000).toFixed(1);

            return (
              <div key={i} className="flex items-start gap-2 leading-snug">
                {/* Status icon */}
                {isActive ? (
                  <span className="mt-0.5 w-3.5 h-3.5 flex items-center justify-center shrink-0">
                    <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                  </span>
                ) : (
                  <span className="mt-0.5 w-3.5 h-3.5 flex items-center justify-center shrink-0 text-green-500">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                )}
                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-gray-400 tabular-nums shrink-0">+{relTime}s</span>
                    <span className={`text-xs ${isActive ? 'text-purple-700 font-medium' : 'text-gray-600'}`}>
                      {entry.message}
                    </span>
                  </div>
                  {/* Detail sub-lines */}
                  {entry.detail && (
                    <div className="ml-[3.25rem] text-xs text-gray-400 space-y-0.5 mt-0.5">
                      {entry.detail.keywords && entry.detail.keywords.length > 0 && (
                        <div>Keywords: {entry.detail.keywords.join(', ')}
                          {entry.detail.newChunksAdded !== undefined && entry.detail.newChunksAdded > 0 && (
                            <span className="text-green-500"> +{entry.detail.newChunksAdded} new chunks</span>
                          )}
                        </div>
                      )}
                      {entry.detail.topCitations && entry.detail.topCitations.length > 0 && (
                        <div className="truncate">{entry.detail.topCitations.join(', ')}</div>
                      )}
                      {entry.detail.provider && entry.detail.model && (
                        <div>{entry.detail.provider}/{entry.detail.model}</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Waiting indicator when generating */}
          {loading && lastEntry?.step === 'generating' && (
            <div className="ml-[1.375rem] text-xs text-purple-400 animate-pulse">
              waiting for response...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
