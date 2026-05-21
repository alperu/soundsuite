'use client';

import { useEffect, useRef, useState } from 'react';
import { COURT_TYPES, type CourtType } from '@/lib/courts/client';

interface Props {
  type: CourtType | '';
  q: string;
  onTypeChange: (t: CourtType | '') => void;
  onQChange: (q: string) => void;
  totalCount: number;
}

export function CourtFilterRail({ type, q, onTypeChange, onQChange, totalCount }: Props) {
  const [localQ, setLocalQ] = useState(q);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalQ(q);
  }, [q]);

  // Debounce 250ms
  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => {
      if (localQ !== q) onQChange(localQ);
    }, 250);
    return () => {
      if (debRef.current) clearTimeout(debRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localQ]);

  return (
    <aside
      style={{ width: 240, minWidth: 240 }}
      className="border-r border-gray-200 bg-gray-50 flex flex-col flex-shrink-0"
    >
      <div className="p-3 border-b border-gray-200">
        <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
          Search
        </label>
        <input
          type="text"
          value={localQ}
          onChange={(e) => setLocalQ(e.target.value)}
          placeholder="Court name…"
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <p className="text-[11px] text-gray-400 mt-2">
          {totalCount} {totalCount === 1 ? 'court' : 'courts'}
        </p>
      </div>

      <div className="p-3">
        <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Type</p>
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => onTypeChange('')}
            className={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
              type === '' ? 'bg-blue-100 text-blue-800 font-medium' : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            All types
          </button>
          {COURT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onTypeChange(type === t ? '' : t)}
              className={`w-full text-left px-2 py-1 text-xs rounded transition-colors capitalize ${
                type === t ? 'bg-blue-100 text-blue-800 font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
