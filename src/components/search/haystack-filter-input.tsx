'use client';

/**
 * Haystack-style filter input with token autocomplete.
 *
 * Users type `judge:` (or any recognized token from TOKEN_MAP) and the parent
 * renders an in-place picker in the left rail (see ActiveTokenSuggestions).
 * Selecting a value inserts a structured chip into the input which compiles
 * to a Haystack filter via haystack-query-builder.
 *
 * Modes coexist:
 *   - Plain text (residual freetext that survives along the chips)
 *   - Filter chips (rendered as pills with category-colored borders)
 *
 * Keyboard:
 *   - `<token>:` activates the left-rail picker for that token
 *   - Arrow up/down navigates the picker's highlight (mirrored in parent state)
 *   - Enter selects the focused option (or submits on plain text when picker closed)
 *   - Escape clears the active token
 *   - Backspace at column 0 with empty text removes the last chip
 *
 * The floating dropdown that used to render here was removed in Task #36 —
 * the left rail is now the authoritative suggestion surface. A small token-
 * prefix suggester remains inline beneath the input (e.g. typing `jud`
 * proposes `judge:` / `judgeBy:`) because it doesn't take a partial value yet.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FilterChip,
  TOKEN_MAP,
  TOKEN_KEYS,
} from '@/lib/search/haystack-query-builder';
import {
  activeTokenAtCursor,
  type ActiveToken,
  type PickedSuggestion,
} from './active-token-suggestions';

// ---------------------------------------------------------------------------
// Visual helpers

const categoryClasses: Record<string, string> = {
  ref: 'border-blue-400 bg-blue-50 text-blue-900',
  date: 'border-green-400 bg-green-50 text-green-900',
  enum: 'border-purple-400 bg-purple-50 text-purple-900',
  number: 'border-gray-400 bg-gray-50 text-gray-900',
  text: 'border-gray-300 bg-white text-gray-800',
};

// ---------------------------------------------------------------------------
// Helpers

/** Strip a trailing `token:partial` from freetext when a chip is committed. */
export function stripActiveTokenFromText(text: string, active: ActiveToken): string {
  // Cut [startIndex, endIndex) and trim any trailing whitespace introduced.
  const before = text.slice(0, active.startIndex);
  const after = text.slice(active.endIndex);
  const joined = (before + after).replace(/\s+$/, '');
  return joined;
}

/**
 * Task #55: walk the chip array from a paren index and find its match. Used
 * to highlight the paired paren on hover. Returns null if unbalanced.
 */
export function matchingParenIdx(chips: FilterChip[], idx: number): number | null {
  const t = chips[idx];
  if (!t) return null;
  const kind = (t as { kind?: string }).kind;
  if (kind !== 'lparen' && kind !== 'rparen') return null;
  if (kind === 'lparen') {
    let depth = 0;
    for (let i = idx; i < chips.length; i++) {
      const k = (chips[i] as { kind?: string }).kind;
      if (k === 'lparen') depth++;
      else if (k === 'rparen') { depth--; if (depth === 0) return i; }
    }
  } else {
    let depth = 0;
    for (let i = idx; i >= 0; i--) {
      const k = (chips[i] as { kind?: string }).kind;
      if (k === 'rparen') depth++;
      else if (k === 'lparen') { depth--; if (depth === 0) return i; }
    }
  }
  return null;
}

/**
 * Task #55: scan a freshly-typed freetext string and pull out any operator
 * chips that can be auto-committed. Returns the remaining freetext plus the
 * chips to splice in. The rules (gated by trailing space or paren typed):
 *   - `(` and `)` anywhere → committed as lparen/rparen, removed from text
 *   - trailing whole-word lowercase `and`/`or`/`not` followed by space →
 *     committed as the operator chip, the word + space removed
 *   - whole-word bare term followed by space, when an operator chip exists
 *     elsewhere in the array (else leave as freetext) — kept simple: we ONLY
 *     auto-commit operators here. Bare terms remain in freetext until the
 *     parent's submit pipeline handles them.
 *
 * Note we only commit lowercase operators. Uppercase typed → falls through
 * as bare freetext, the parser pill catches it with the explicit error.
 */
export function extractInlineChips(
  freetext: string,
  trigger: 'space' | 'lparen' | 'rparen',
): { remaining: string; newChips: FilterChip[] } {
  const newChips: FilterChip[] = [];
  // Paren triggers commit immediately.
  if (trigger === 'lparen') {
    return { remaining: freetext, newChips: [{ kind: 'lparen' }] };
  }
  if (trigger === 'rparen') {
    return { remaining: freetext, newChips: [{ kind: 'rparen' }] };
  }
  // Space trigger: check if the trailing word (now followed by the just-typed
  // space) is a lowercase operator.
  const m = freetext.match(/(^|\s)(and|or|not)\s$/);
  if (m) {
    const op = m[2] as 'and' | 'or' | 'not';
    const cutAt = freetext.length - m[0].length + m[1].length;
    const remaining = freetext.slice(0, cutAt).replace(/\s+$/, '');
    newChips.push({ kind: op });
    return { remaining, newChips };
  }
  return { remaining: freetext, newChips: [] };
}

// ---------------------------------------------------------------------------
// Component

export interface HaystackFilterInputProps {
  chips: FilterChip[];
  onChipsChange: (chips: FilterChip[]) => void;
  freetext: string;
  onFreetextChange: (text: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Notifies the parent whenever the active token under the cursor changes.
   * The parent renders ActiveTokenSuggestions in the left rail keyed off this.
   * Called with `null` when the cursor isn't in a recognized token.
   */
  onActiveTokenChange?: (active: ActiveToken | null) => void;
  /**
   * Visible options for the current active token, surfaced by
   * ActiveTokenSuggestions so this input can drive Enter/↑/↓ keyboard nav.
   */
  pickerOptions?: PickedSuggestion[];
  /**
   * Highlight index for the picker. Lifted to parent so keyboard nav here
   * stays in sync with the visible list in the rail.
   */
  pickerHighlight?: number;
  onPickerHighlightChange?: (next: number) => void;
  /**
   * Token-name suggestions (e.g. typing `fi` proposes `filedAfter`,
   * `filedBefore`, `fileRef`). Surfaced to the parent so the left rail can
   * render TokenNameSuggestions instead of the legacy floating dropdown.
   * Empty array when no partial-name match.
   */
  onTokenSuggestionsChange?: (suggestions: string[]) => void;
  /** Highlight index for the token-name list. */
  onTokenHighlightChange?: (next: number) => void;
}

/**
 * Imperative handle exposed via forwardRef so the parent (search-interface)
 * can drive token-completion from a click on the left-rail panel — the input
 * ref lives in this component and we need focus + setSelectionRange to keep
 * post-pick typing landing at the right cursor position.
 */
export interface HaystackFilterInputHandle {
  completeToken: (token: string) => void;
  focus: () => void;
}

export const HaystackFilterInput = forwardRef<
  HaystackFilterInputHandle,
  HaystackFilterInputProps
>(function HaystackFilterInput({
  chips,
  onChipsChange,
  freetext,
  onFreetextChange,
  onSubmit,
  placeholder = 'Filter or ask… (try judge== hearingDate>= motionType==)',
  disabled,
  className,
  style,
  onActiveTokenChange,
  pickerOptions = [],
  pickerHighlight = 0,
  onPickerHighlightChange,
  onTokenSuggestionsChange,
  onTokenHighlightChange,
}: HaystackFilterInputProps, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cursor, setCursor] = useState<number>(0);
  // Task #55: hover-pair highlight for paren chips.
  const [hoveredParen, setHoveredParen] = useState<number | null>(null);

  // ---------------------------------------------------------------------------
  // Active-token detection — runs on every freetext / cursor change.
  // Notifies the parent so it can render the in-place suggestions panel.
  //
  // The cursor index is tracked from the input's selectionEnd; for a single-
  // line <input type="text"> this equals freetext.length while the user is
  // typing at the end (the common case).

  const activeToken = useMemo<ActiveToken | null>(
    () => {
      const primary = activeTokenAtCursor(freetext, cursor);
      if (primary) return primary;
      // Fallback: when freetext changes from OUTSIDE the input (parent calls
      // setAiQuery via a sample-query glossary-chip click), the stale `cursor`
      // from useState is still 0 — so the primary slice never matches. Probe
      // the end of the new string so externally-injected `judge:` opens the
      // picker without requiring a manual click into the input.
      if (cursor !== freetext.length) {
        return activeTokenAtCursor(freetext, freetext.length);
      }
      return null;
    },
    [freetext, cursor],
  );

  // Bubble changes up. We compare a stringified summary so we don't double-fire
  // on identical states.
  const lastEmittedRef = useRef<string>('');
  useEffect(() => {
    const sig = activeToken
      ? `${activeToken.prefix}|${activeToken.partial}|${activeToken.startIndex}|${activeToken.endIndex}`
      : 'null';
    if (sig === lastEmittedRef.current) return;
    lastEmittedRef.current = sig;
    onActiveTokenChange?.(activeToken);
  }, [activeToken, onActiveTokenChange]);

  // ---------------------------------------------------------------------------
  // Chip commit — called from parent (via prop) AND from inline keyboard Enter.

  const commitChip = useCallback(
    (token: string, value: string, label?: string, srcActive?: ActiveToken) => {
      onChipsChange([...chips, { key: token, value, label }]);
      // Strip the matching `token:partial` substring out of the freetext.
      const a =
        srcActive ?? activeTokenAtCursor(freetext, cursor) ?? null;
      if (a) {
        onFreetextChange(stripActiveTokenFromText(freetext, a));
      }
      lastEmittedRef.current = 'null';
      onActiveTokenChange?.(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [chips, freetext, cursor, onChipsChange, onFreetextChange, onActiveTokenChange],
  );

  const removeChipAt = useCallback(
    (idx: number) => {
      onChipsChange(chips.filter((_, i) => i !== idx));
    },
    [chips, onChipsChange],
  );

  // ---------------------------------------------------------------------------
  // Token-prefix suggester: when user types `j` (no colon yet), suggest tokens
  // inline as a tiny tag list below the input. Kept inline — it's just token
  // names, not values.

  const tokenSuggestions = useMemo(() => {
    if (activeToken) return [];
    const m = freetext.match(/(?:^|\s)(\w+)$/);
    if (!m) return [];
    const partial = m[1].toLowerCase();
    if (partial.length < 1) return [];
    const matches = TOKEN_KEYS.filter((k) => k.toLowerCase().startsWith(partial));
    if (matches.length === 0 || (matches.length === 1 && matches[0].toLowerCase() === partial)) {
      return [];
    }
    return matches.slice(0, 8);
  }, [freetext, activeToken]);

  const [tokenHighlight, setTokenHighlightState] = useState(0);
  const setTokenHighlight = useCallback(
    (updater: number | ((prev: number) => number)) => {
      setTokenHighlightState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        onTokenHighlightChange?.(next);
        return next;
      });
    },
    [onTokenHighlightChange],
  );
  useEffect(() => {
    setTokenHighlightState(0);
    onTokenHighlightChange?.(0);
  }, [tokenSuggestions.length, onTokenHighlightChange]);

  // Bubble the token-name suggestion list up to the parent so it can render
  // TokenNameSuggestions in the left rail. We compare a joined signature so
  // we don't re-fire on identical lists.
  const lastTokenSuggestionsSig = useRef('');
  useEffect(() => {
    const sig = tokenSuggestions.join('|');
    if (sig === lastTokenSuggestionsSig.current) return;
    lastTokenSuggestionsSig.current = sig;
    onTokenSuggestionsChange?.(tokenSuggestions);
  }, [tokenSuggestions, onTokenSuggestionsChange]);

  const completeToken = useCallback(
    (token: string) => {
      // When called from the left-rail panel, the freetext may not end in a
      // bare partial (the user could have advanced past it). Fall back to
      // appending `<token>==` with a leading space in that case so clicks from
      // the panel still work even when the regex doesn't match.
      // Task #57: Axon-canonical `==` (the parser normalizes legacy `:` so
      // both still parse, but the suggestion always offers canonical).
      const re = /(?:^|\s)(\w+)$/;
      const next = re.test(freetext)
        ? freetext.replace(re, (m) => {
            const ws = m.match(/^\s/) ? ' ' : '';
            return `${ws}${token}==`;
          })
        : `${freetext.replace(/\s+$/, '')}${freetext.trim() ? ' ' : ''}${token}==`;
      onFreetextChange(next);
      // Move cursor to end so activeTokenAtCursor picks up the new prefix.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          const pos = next.length;
          el.setSelectionRange(pos, pos);
          setCursor(pos);
        }
      });
    },
    [freetext, onFreetextChange],
  );

  // Imperative handle — parent calls this from a click on the left-rail
  // TokenNameSuggestions panel. Keeping focus + cursor sync inside this
  // component avoids leaking inputRef through props.
  useImperativeHandle(
    ref,
    () => ({
      completeToken,
      focus: () => inputRef.current?.focus(),
    }),
    [completeToken],
  );

  // ---------------------------------------------------------------------------
  // Picker-Enter commit (used when an option is highlighted in the rail).

  const commitHighlightedOption = useCallback(() => {
    if (!activeToken) return false;
    const opt = pickerOptions[pickerHighlight];
    if (!opt) return false;
    commitChip(activeToken.prefix, opt.value, opt.label, activeToken);
    return true;
  }, [activeToken, pickerOptions, pickerHighlight, commitChip]);

  // ---------------------------------------------------------------------------
  // Keyboard

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Active-token picker open: arrow / enter / escape
      if (activeToken && pickerOptions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onPickerHighlightChange?.(
            Math.min(pickerHighlight + 1, pickerOptions.length - 1),
          );
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onPickerHighlightChange?.(Math.max(pickerHighlight - 1, 0));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (commitHighlightedOption()) return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          // Clear the partial so activeToken goes null.
          onFreetextChange(stripActiveTokenFromText(freetext, activeToken));
          onActiveTokenChange?.(null);
          lastEmittedRef.current = 'null';
          return;
        }
      }

      // Active token but no list (date/number/empty refs): Enter commits the
      // user's typed partial verbatim as the chip value.
      if (activeToken && pickerOptions.length === 0 && e.key === 'Enter') {
        const def = TOKEN_MAP[activeToken.prefix];
        if (def && (def.category === 'date' || def.category === 'number') && activeToken.partial.trim()) {
          e.preventDefault();
          commitChip(
            activeToken.prefix,
            activeToken.partial.trim(),
            activeToken.partial.trim(),
            activeToken,
          );
          return;
        }
      }

      // Token suggestions visible: navigate / complete
      if (tokenSuggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setTokenHighlight((h) => Math.min(h + 1, tokenSuggestions.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setTokenHighlight((h) => Math.max(h - 1, 0));
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !activeToken)) {
          e.preventDefault();
          completeToken(tokenSuggestions[tokenHighlight]);
          return;
        }
      }

      // Backspace at empty input → remove last chip.
      if (e.key === 'Backspace' && freetext === '' && chips.length > 0) {
        e.preventDefault();
        onChipsChange(chips.slice(0, -1));
        return;
      }

      // Plain Enter → submit.
      if (e.key === 'Enter' && !e.shiftKey && !activeToken) {
        e.preventDefault();
        onSubmit?.();
      }
    },
    [
      activeToken,
      pickerOptions,
      pickerHighlight,
      onPickerHighlightChange,
      commitHighlightedOption,
      commitChip,
      freetext,
      onFreetextChange,
      onActiveTokenChange,
      tokenSuggestions,
      tokenHighlight,
      chips,
      completeToken,
      onChipsChange,
      onSubmit,
    ],
  );

  // ---------------------------------------------------------------------------
  // Cursor tracking — update on every selection change so activeToken is fresh.

  const syncCursor = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const pos = el.selectionEnd ?? el.value.length;
    setCursor(pos);
  }, []);

  // ---------------------------------------------------------------------------
  // Render

  return (
    <div className={`relative ${className ?? ''}`}>
      <div
        className="flex flex-wrap content-start items-start gap-1.5 px-2 py-1.5 border border-gray-300 rounded-lg bg-white focus-within:ring-2 focus-within:ring-purple-500 focus-within:border-transparent overflow-y-auto"
        style={style}
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((c, i) => {
          const kind = (c as { kind?: string }).kind;
          // Task #55: operator/paren/term variants. The pill text is uppercase
          // even though canonical syntax is lowercase (matches the
          // boolean-chip-composer convention).
          if (kind === 'and' || kind === 'or' || kind === 'not') {
            const opClasses =
              kind === 'and' ? 'border-blue-300 bg-blue-100 text-blue-700' :
              kind === 'or'  ? 'border-purple-300 bg-purple-100 text-purple-700' :
                               'border-red-300 bg-red-100 text-red-700';
            return (
              <button
                key={`op-${i}-${kind}`}
                type="button"
                onClick={() => removeChipAt(i)}
                title={`${kind.toUpperCase()} (click to remove)`}
                aria-label={`${kind.toUpperCase()} operator. Click to remove.`}
                className={`inline-flex items-center text-[10px] font-semibold uppercase px-2 py-0.5 border rounded ${opClasses}`}
              >
                {kind}
              </button>
            );
          }
          if (kind === 'lparen' || kind === 'rparen') {
            const isMatch = hoveredParen !== null &&
              (i === hoveredParen || i === matchingParenIdx(chips, hoveredParen));
            const matchBg = isMatch ? 'bg-amber-100 border-amber-400' : 'bg-gray-50 border-gray-300';
            return (
              <button
                key={`paren-${i}-${kind}`}
                type="button"
                onClick={() => removeChipAt(i)}
                onMouseEnter={() => setHoveredParen(i)}
                onMouseLeave={() => setHoveredParen(null)}
                title={`${kind === 'lparen' ? 'Open' : 'Close'} paren (click to remove)`}
                aria-label={`${kind === 'lparen' ? 'Open' : 'Close'} paren. Click to remove.`}
                className={`inline-flex items-center text-xs font-mono px-1.5 py-0.5 border rounded text-gray-700 ${matchBg}`}
              >
                {kind === 'lparen' ? '(' : ')'}
              </button>
            );
          }
          if (kind === 'term') {
            const tc = c as { kind: 'term'; value: string; phrase?: boolean };
            return (
              <button
                key={`term-${i}-${tc.value}`}
                type="button"
                onClick={() => removeChipAt(i)}
                title={`Term: ${tc.value} (click to remove)`}
                aria-label={`Term ${tc.value}. Click to remove.`}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs border border-gray-300 bg-white text-gray-800 rounded-md font-mono"
              >
                {tc.phrase ? `"${tc.value}"` : tc.value}
                <span className="opacity-60">×</span>
              </button>
            );
          }
          // Default: field-op chip (legacy shape).
          const fc = c as { key: string; value: string; label?: string };
          const def = TOKEN_MAP[fc.key];
          const cat = def?.category ?? 'text';
          return (
            <span
              key={`${fc.key}-${i}-${fc.value}`}
              className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded-full ${categoryClasses[cat] ?? categoryClasses.text}`}
              title={`${fc.key}: ${fc.label ?? fc.value}`}
            >
              <span className="opacity-70">{fc.key}:</span>
              <span>{fc.label ?? fc.value}</span>
              <button
                type="button"
                onClick={() => removeChipAt(i)}
                className="ml-0.5 text-current opacity-60 hover:opacity-100"
                aria-label={`Remove ${fc.key} filter`}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          value={freetext}
          onChange={(e) => {
            const next = e.target.value;
            // Task #55: inline-operator / paren tokenization. Detect the just-
            // typed char by comparing lengths; only single-char inserts at the
            // end trigger the auto-commit. Paste/multi-char edits fall through
            // to plain freetext.
            const prev = freetext;
            const grew = next.length === prev.length + 1 && next.startsWith(prev);
            const lastChar = grew ? next[next.length - 1] : null;
            // Don't auto-commit while a `token:partial` picker is active —
            // typing space inside a date or enum picker should not eat the word.
            const insidePicker = activeTokenAtCursor(next, next.length) !== null;

            if (!insidePicker && lastChar === '(') {
              // Drop the typed `(`; insert lparen chip.
              const trimmed = next.slice(0, -1);
              onChipsChange([...chips, { kind: 'lparen' } as FilterChip]);
              onFreetextChange(trimmed);
              requestAnimationFrame(syncCursor);
              return;
            }
            if (!insidePicker && lastChar === ')') {
              const trimmed = next.slice(0, -1);
              onChipsChange([...chips, { kind: 'rparen' } as FilterChip]);
              onFreetextChange(trimmed);
              requestAnimationFrame(syncCursor);
              return;
            }
            if (!insidePicker && lastChar === ' ') {
              const { remaining, newChips } = extractInlineChips(next, 'space');
              if (newChips.length > 0) {
                onChipsChange([...chips, ...newChips]);
                onFreetextChange(remaining);
                requestAnimationFrame(syncCursor);
                return;
              }
            }
            onFreetextChange(next);
            // Defer to next frame so selectionEnd reflects the new value.
            requestAnimationFrame(syncCursor);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCursor}
          onClick={syncCursor}
          onSelect={syncCursor}
          onFocus={syncCursor}
          placeholder={chips.length === 0 ? placeholder : ''}
          disabled={disabled}
          className="flex-1 min-w-[120px] px-1 py-1 text-sm bg-transparent outline-none border-0"
        />
      </div>

      {/* Token-name suggester used to float here; it now renders in the left
          rail via TokenNameSuggestions (see search-interface.tsx). Keyboard
          nav + Enter/Tab commit still live in handleKeyDown above. */}
    </div>
  );
});

// Re-export the helper + types so callers (search-interface) can share them.
export { activeTokenAtCursor } from './active-token-suggestions';
export type { ActiveToken, PickedSuggestion } from './active-token-suggestions';
