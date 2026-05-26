'use client';

/**
 * TokenNameSuggestions — left-rail picker for partial token names.
 *
 * When the user types a bare word (no colon) at the end of the freetext
 * (e.g. `fi`), HaystackFilterInput computes a small set of matching token
 * names from TOKEN_MAP (e.g. `filedAfter`, `filedBefore`, `fileRef`) and the
 * parent surfaces that list here instead of overlaying it as a floating
 * dropdown above the input.
 *
 * This component is the third tenant of the /search left rail:
 *   - `activeToken != null`              → ActiveTokenSuggestions (values)
 *   - `tokenSuggestions.length > 0`      → TokenNameSuggestions   (this)
 *   - otherwise                          → SampleQueryPanel
 *
 * Keyboard navigation (↑ / ↓ / Enter / Tab) is owned by HaystackFilterInput's
 * `handleKeyDown` — it nudges `tokenHighlight` and calls `completeToken` on
 * commit. This component just renders the list, mirrors the highlight, and
 * forwards mouse clicks back through `onPick`.
 */

import React from 'react';
import { TOKEN_MAP } from '@/lib/search/haystack-query-builder';

export interface TokenNameSuggestionsProps {
  /** Matching token names — already filtered + capped by the parent. */
  suggestions: string[];
  /** Keyboard-driven highlight index (mirrored from HaystackFilterInput). */
  highlight: number;
  /** Commit a token by inserting `<token>:` into freetext at cursor. */
  onPick: (token: string) => void;
}

export function TokenNameSuggestions({
  suggestions,
  highlight,
  onPick,
}: TokenNameSuggestionsProps) {
  return (
    <aside
      className="w-[300px] shrink-0 border-r border-gray-200 bg-white overflow-y-auto flex flex-col"
      aria-label="Filter token suggestions"
    >
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h4 className="text-[10px] uppercase tracking-wide text-gray-500">
          Filter tokens
        </h4>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Pick a token to start filtering, or keep typing to narrow.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        <ul className="py-1">
          {suggestions.map((tok, i) => {
            const def = TOKEN_MAP[tok];
            const op = def?.op ?? '==';
            return (
              <li key={tok}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    // Keep focus in the input so the next keystroke lands
                    // correctly. Mirrors ActiveTokenSuggestions row pattern.
                    e.preventDefault();
                    onPick(tok);
                  }}
                  className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-purple-50 ${
                    i === highlight ? 'bg-purple-100' : ''
                  }`}
                >
                  <span className="font-mono text-gray-800">{tok}{op}</span>
                  {def?.category && (
                    <span className="ml-2 text-[10px] text-gray-500">
                      {def.category}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
