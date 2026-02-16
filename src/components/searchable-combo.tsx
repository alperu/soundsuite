'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface SearchableComboProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
}

export function SearchableCombo({ value, onChange, options, placeholder, className }: SearchableComboProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const filtered = query.trim()
    ? options.filter(o => o.toLowerCase().includes(query.toLowerCase())).slice(0, 50)
    : options.slice(0, 50);

  const handleSelect = useCallback((opt: string) => {
    onChange(opt);
    setQuery('');
    setOpen(false);
  }, [onChange]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={wrapperRef} className={`relative ${className || ''}`}>
      <div className="flex">
        <input
          ref={inputRef}
          type="text"
          value={open ? query : value}
          onChange={e => { setQuery(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => { setOpen(true); setQuery(''); }}
          placeholder={value || placeholder}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 pr-8"
        />
        <button
          type="button"
          onClick={() => { setOpen(!open); if (!open) inputRef.current?.focus(); }}
          className="absolute right-0 top-0 h-full px-2 text-gray-400 hover:text-gray-600"
        >
          <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
      {open && (
        <div ref={listRef}
          className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400">No matches</div>
          ) : (
            filtered.map((opt, i) => (
              <button key={`${opt}-${i}`} type="button"
                onClick={() => handleSelect(opt)}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 transition-colors ${
                  opt === value ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'
                }`}>
                {opt}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
