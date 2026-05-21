'use client';

/**
 * Left-rail "How to ask" panel for the search interface.
 *
 * Renders a categorized list of clickable sample queries (English prompts that
 * round-trip through Task #5's `POST /api/search/interpret` endpoint when
 * available, or fall back to populating the input verbatim).
 *
 * Below the samples, a token glossary lets users click a recognized token
 * prefix (e.g. `judge:`) to inject it into the input and immediately open the
 * matching picker inside `HaystackFilterInput`.
 *
 * The parent owns the input state; this panel just emits intent.
 */

import React, { useState } from 'react';
import {
  SAMPLE_QUERIES,
  SAMPLE_CATEGORY_LABEL,
  TOKEN_GLOSSARY,
  type SampleQuery,
  type SampleCategory,
} from '@/lib/search/sample-queries';

export interface SampleQueryPanelProps {
  /**
   * Called when the user clicks a sample row. The parent should attempt to
   * round-trip through the interpreter; on failure (or until Task #5 lands),
   * setting the freetext input to the prompt is an acceptable fallback.
   */
  onSelectQuery: (q: SampleQuery) => void;
  /**
   * Called when the user clicks a token glossary chip. The parent should
   * append `<token>:` to the freetext (with a leading space if non-empty) so
   * `HaystackFilterInput`'s prefix-detector opens the picker for that token.
   */
  onSelectToken: (token: string) => void;
}

const CATEGORY_ORDER: SampleCategory[] = [
  'date',
  'judge',
  'role',
  'hearing',
  'amendment',
  'person',
];

export function SampleQueryPanel({ onSelectQuery, onSelectToken }: SampleQueryPanelProps) {
  // Hover state — surfaces the compiled filter on the hovered row.
  const [hovered, setHovered] = useState<string | null>(null);

  const grouped = new Map<SampleCategory, SampleQuery[]>();
  for (const cat of CATEGORY_ORDER) grouped.set(cat, []);
  for (const q of SAMPLE_QUERIES) {
    const arr = grouped.get(q.category) ?? [];
    arr.push(q);
    grouped.set(q.category, arr);
  }

  return (
    <aside
      className="w-[300px] shrink-0 border-r border-gray-200 bg-white overflow-y-auto"
      aria-label="Sample queries"
    >
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-800">How to ask</h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Click a prompt to populate the search bar.
        </p>
      </div>

      <div className="px-3 py-3 space-y-4">
        {CATEGORY_ORDER.map((cat) => {
          const items = grouped.get(cat) ?? [];
          if (items.length === 0) return null;
          return (
            <section key={cat}>
              <h4 className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-1">
                {SAMPLE_CATEGORY_LABEL[cat]}
              </h4>
              <ul className="space-y-1">
                {items.map((q) => {
                  const key = `${cat}:${q.englishPrompt}`;
                  const isHover = hovered === key;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => onSelectQuery(q)}
                        onMouseEnter={() => setHovered(key)}
                        onMouseLeave={() => setHovered((h) => (h === key ? null : h))}
                        title={q.description}
                        className="group w-full text-left rounded-md border border-transparent px-2 py-1.5 text-xs text-gray-700 hover:bg-purple-50 hover:border-purple-200 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-1.5">
                          <span className="flex-1 leading-snug">{q.englishPrompt}</span>
                          <svg
                            className="w-3 h-3 mt-0.5 text-gray-300 group-hover:text-purple-500 shrink-0"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                          >
                            <path
                              fillRule="evenodd"
                              d="M7.293 5.293a1 1 0 011.414 0l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414-1.414L10.586 10 7.293 6.707a1 1 0 010-1.414z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                        {isHover && (
                          <div className="mt-1 font-mono text-[10px] text-purple-700 bg-purple-50 border border-purple-100 rounded px-1.5 py-1 break-all">
                            {q.compiledFilter}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <div className="border-t border-gray-200 px-4 py-3 bg-gray-50">
        <h4 className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5">
          Filter tokens
        </h4>
        <p className="text-[10px] text-gray-500 mb-2">
          Click to insert into the search bar.
        </p>
        <div className="flex flex-wrap gap-1">
          {TOKEN_GLOSSARY.map((t) => (
            <button
              key={t.token}
              type="button"
              onClick={() => onSelectToken(t.token)}
              title={t.hint}
              className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-gray-200 bg-white text-gray-700 hover:bg-purple-50 hover:border-purple-300 hover:text-purple-700 transition-colors"
            >
              {t.token}:
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
