'use client';

import { useEffect, useState } from 'react';
import { INTRINSIC_MARKERS, type IntrinsicMarker } from '@/lib/personas/client';

interface Props {
  tags: IntrinsicMarker[];
  q: string;
  onTagsChange: (tags: IntrinsicMarker[]) => void;
  onQChange: (q: string) => void;
  totalCount?: number;
}

/**
 * Left rail: intrinsic-marker multi-select + debounced free-text search.
 */
export function PersonaFilterRail({ tags, q, onTagsChange, onQChange, totalCount }: Props) {
  const [localQ, setLocalQ] = useState(q);

  // Debounce q changes (250ms)
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (localQ !== q) onQChange(localQ);
    }, 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localQ]);

  useEffect(() => {
    // Sync from URL if it changes externally
    if (q !== localQ) setLocalQ(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const toggle = (m: IntrinsicMarker) => {
    const has = tags.includes(m);
    onTagsChange(has ? tags.filter(t => t !== m) : [...tags, m]);
  };

  return (
    <div className="w-60 border-r border-gray-200 bg-gray-50 flex flex-col flex-shrink-0">
      <div className="px-3 py-2 border-b border-gray-200 bg-white">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Filter</h2>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-gray-200">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 px-1">
          Search name
        </label>
        <div className="relative mt-1">
          <input
            type="text"
            value={localQ}
            onChange={(e) => setLocalQ(e.target.value)}
            placeholder="Type a name…"
            className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
          />
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      {/* Intrinsic markers */}
      <div className="p-2 flex-1 overflow-y-auto">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 px-1 mb-1">
          Intrinsic markers
        </div>
        <div className="space-y-0.5">
          {INTRINSIC_MARKERS.map((m) => {
            const checked = tags.includes(m);
            return (
              <label
                key={m}
                className={`flex items-center gap-2 px-2 py-1 text-xs rounded cursor-pointer transition-colors ${
                  checked ? 'bg-green-50 text-green-800' : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(m)}
                  className="w-3.5 h-3.5 rounded border-gray-300 text-green-600 focus:ring-green-500"
                />
                <span className="flex-1">{m}</span>
              </label>
            );
          })}
        </div>

        {(tags.length > 0 || q) && (
          <button
            type="button"
            onClick={() => { onTagsChange([]); onQChange(''); setLocalQ(''); }}
            className="mt-3 w-full text-[11px] text-gray-500 hover:text-blue-700 hover:underline text-center py-1"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Footer */}
      {totalCount !== undefined && (
        <div className="px-3 py-1.5 border-t border-gray-200 bg-white text-[11px] text-gray-500">
          {totalCount} {totalCount === 1 ? 'persona' : 'personas'}
        </div>
      )}
    </div>
  );
}
