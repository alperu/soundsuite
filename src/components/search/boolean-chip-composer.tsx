'use client';

// Chip-based boolean query composer for /search Advanced mode.
// Single source of truth = the canonical `value` string from the parent.
// Internally we keep a FlatToken[] derived from `value`, edit it, then
// re-serialize on every change and call onChange(string).
//
// The component is self-contained except for:
//   - parseBooleanQuery from boolean-query.ts (live syntax pill)
//   - isLikelyMidTyping from filter-logic-panel.tsx (muted "incomplete…" pill)
//
// Visual language matches HaystackChipInput (haystack-filter-input.tsx):
// rounded-full chips, gap-1.5, px-2 py-0.5, text-xs/sm, border + bg.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseBooleanQuery } from '@/lib/search/boolean-query';
import { isLikelyMidTyping } from './filter-logic-panel';

// ---------------------------------------------------------------------------
// FlatToken — the internal data model.

export type FlatToken =
  | { id: string; kind: 'term'; value: string; field?: string; phrase: boolean }
  | { id: string; kind: 'and' | 'or' | 'not' }
  | { id: string; kind: 'lparen' | 'rparen' };

let __tokenIdSeq = 0;
function newId(): string {
  __tokenIdSeq += 1;
  return `t${__tokenIdSeq}`;
}

// ---------------------------------------------------------------------------
// stringToTokens — best-effort tokenizer that mirrors the parser's lexer but
// emits FlatTokens. Even on a malformed input we return a token list so the
// user can fix the broken state inline.

export function stringToTokens(input: string): FlatToken[] {
  const out: FlatToken[] = [];
  const n = input.length;
  let i = 0;
  let atWordBoundary = true;

  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const isTermChar = (c: string) => !isWs(c) && c !== '(' && c !== ')' && c !== '"';

  while (i < n) {
    const c = input[i];
    if (isWs(c)) { i++; atWordBoundary = true; continue; }
    if (c === '(') { out.push({ id: newId(), kind: 'lparen' }); i++; atWordBoundary = true; continue; }
    if (c === ')') { out.push({ id: newId(), kind: 'rparen' }); i++; atWordBoundary = false; continue; }

    if (c === '-' && atWordBoundary) {
      const next = input[i + 1];
      if (next !== undefined && !isWs(next) && next !== ')' && next !== '-') {
        out.push({ id: newId(), kind: 'not' });
        i++; atWordBoundary = false;
        continue;
      }
    }

    if (c === '"') {
      i++;
      let buf = '';
      let closed = false;
      while (i < n) {
        const ch = input[i];
        if (ch === '\\' && i + 1 < n) {
          const nx = input[i + 1];
          if (nx === '"' || nx === '\\') { buf += nx; i += 2; continue; }
          buf += ch; i++; continue;
        }
        if (ch === '"') { closed = true; i++; break; }
        buf += ch; i++;
      }
      // Even if unclosed, accept the partial phrase as a chip.
      out.push({ id: newId(), kind: 'term', value: buf, phrase: true });
      atWordBoundary = false;
      if (!closed) break;
      continue;
    }

    // Bare term — collect until whitespace, paren, or quote.
    let buf = '';
    while (i < n && isTermChar(input[i])) { buf += input[i]; i++; }
    if (buf.length === 0) { i++; continue; }

    // Field-qualified `field:value` (or `field:"phrase"`).
    if (buf[0] !== ':') {
      const colonIdx = buf.indexOf(':');
      if (colonIdx > 0) {
        const fieldName = buf.slice(0, colonIdx);
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName)) {
          const rest = buf.slice(colonIdx + 1);
          if (rest.length > 0) {
            out.push({ id: newId(), kind: 'term', value: rest, field: fieldName, phrase: false });
            atWordBoundary = false;
            continue;
          }
          // Trailing colon: check for following phrase.
          if (i < n && input[i] === '"') {
            i++;
            let pbuf = '';
            let closed = false;
            while (i < n) {
              const ch = input[i];
              if (ch === '\\' && i + 1 < n) {
                const nx = input[i + 1];
                if (nx === '"' || nx === '\\') { pbuf += nx; i += 2; continue; }
                pbuf += ch; i++; continue;
              }
              if (ch === '"') { closed = true; i++; break; }
              pbuf += ch; i++;
            }
            out.push({ id: newId(), kind: 'term', value: pbuf, field: fieldName, phrase: true });
            atWordBoundary = false;
            if (!closed) break;
            continue;
          }
          // No value yet — empty field chip with no value (still useful in composer).
          out.push({ id: newId(), kind: 'term', value: '', field: fieldName, phrase: false });
          atWordBoundary = false;
          continue;
        }
      }
    }

    const upper = buf.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
      out.push({ id: newId(), kind: upper.toLowerCase() as 'and' | 'or' | 'not' });
      atWordBoundary = false;
      continue;
    }

    out.push({ id: newId(), kind: 'term', value: buf, phrase: false });
    atWordBoundary = false;
  }

  return out;
}

// ---------------------------------------------------------------------------
// tokensToString — serialize FlatTokens back to a canonical string.
// We just join with single spaces; the parser handles whitespace and
// implicit-AND. Phrase chips get quoted. Field chips get `field:value` or
// `field:"phrase"`.

export function tokensToString(tokens: FlatToken[]): string {
  const parts: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'term') {
      const prefix = t.field ? `${t.field}:` : '';
      if (t.phrase) {
        const esc = t.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        parts.push(`${prefix}"${esc}"`);
      } else if (t.field && t.value === '') {
        parts.push(`${prefix}`); // bare field with no value — parser will flag.
      } else {
        parts.push(`${prefix}${t.value}`);
      }
    } else if (t.kind === 'and') parts.push('and');
    else if (t.kind === 'or') parts.push('or');
    else if (t.kind === 'not') parts.push('not');
    else if (t.kind === 'lparen') parts.push('(');
    else if (t.kind === 'rparen') parts.push(')');
  }
  // Compact `( foo` → `(foo` and `foo )` → `foo)` for nicer canonical strings.
  return parts
    .join(' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

// ---------------------------------------------------------------------------
// matchingParenIndex — given a token index of a paren, find its match.

function matchingParenIndex(tokens: FlatToken[], idx: number): number | null {
  const t = tokens[idx];
  if (!t || (t.kind !== 'lparen' && t.kind !== 'rparen')) return null;
  if (t.kind === 'lparen') {
    let depth = 0;
    for (let i = idx; i < tokens.length; i++) {
      const x = tokens[i];
      if (x.kind === 'lparen') depth++;
      else if (x.kind === 'rparen') { depth--; if (depth === 0) return i; }
    }
  } else {
    let depth = 0;
    for (let i = idx; i >= 0; i--) {
      const x = tokens[i];
      if (x.kind === 'rparen') depth++;
      else if (x.kind === 'lparen') { depth--; if (depth === 0) return i; }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Props.

export type BooleanChipComposerProps = {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  fieldNames?: string[];
  placeholder?: string;
  autoFocus?: boolean;
};

// ---------------------------------------------------------------------------
// Icons (inline SVG — no lucide-react in package.json).

function QuoteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 7h3v4H8c0 1.7 1 3 3 3v2c-3 0-5-2-5-5V7zm8 0h3v4h-2c0 1.7 1 3 3 3v2c-3 0-5-2-5-5V7z" />
    </svg>
  );
}

function CaretIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 8 8" fill="currentColor" aria-hidden="true">
      <path d="M2 3l2 2 2-2z" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// BooleanChipComposer.

export default function BooleanChipComposer({
  value,
  onChange,
  onSubmit,
  fieldNames = [],
  placeholder = 'Build a boolean query…',
  autoFocus = false,
}: BooleanChipComposerProps): React.JSX.Element {
  const [tokens, setTokens] = useState<FlatToken[]>(() => stringToTokens(value));
  const [caret, setCaret] = useState<number>(() => stringToTokens(value).length);
  const [focused, setFocused] = useState<boolean>(autoFocus);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftInput, setDraftInput] = useState<string>(''); // for "insert at caret"
  const [showDraft, setShowDraft] = useState<boolean>(false);
  const [fieldDropdownChipId, setFieldDropdownChipId] = useState<string | null>(null);
  const [sourceView, setSourceView] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('boolean-composer-source-view') === '1';
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const lastEmittedRef = useRef<string>(value);

  // External value → tokens (only when value changes from outside).
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    const nextTokens = stringToTokens(value);
    setTokens(nextTokens);
    setCaret(c => Math.min(c, nextTokens.length));
    lastEmittedRef.current = value;
  }, [value]);

  // Internal mutation → string out.
  const commitTokens = useCallback((next: FlatToken[], nextCaret?: number) => {
    setTokens(next);
    if (typeof nextCaret === 'number') setCaret(Math.max(0, Math.min(nextCaret, next.length)));
    const s = tokensToString(next);
    lastEmittedRef.current = s;
    onChange(s);
  }, [onChange]);

  // Parse for live syntax feedback.
  const parseResult = useMemo(() => parseBooleanQuery(value), [value]);
  const summary = useMemo(() => {
    if (!parseResult.ok || !parseResult.hasOperators) return null;
    let terms = 0, ops = 0;
    const walk = (n: any) => {
      if (n.op === 'TERM') terms++;
      else if (n.op === 'NOT') { ops++; walk(n.child); }
      else { ops += Math.max(0, n.children.length - 1); n.children.forEach(walk); }
    };
    walk(parseResult.ast);
    return { terms, ops };
  }, [parseResult]);

  const midTyping = !parseResult.ok && isLikelyMidTyping(value, parseResult.position);

  // Compute matching paren highlight.
  const [hoveredParen, setHoveredParen] = useState<number | null>(null);
  const matchedParen = hoveredParen !== null ? matchingParenIndex(tokens, hoveredParen) : null;

  // ---------------------------------------------------------------------------
  // Draft-input commit logic — parse the typed string and insert tokens.

  const commitDraftInput = useCallback((raw: string, insertAt: number) => {
    const trimmed = raw.trim();
    if (!trimmed) { setShowDraft(false); setDraftInput(''); return; }
    const newTokens = stringToTokens(trimmed);
    if (newTokens.length === 0) { setShowDraft(false); setDraftInput(''); return; }
    const next = [...tokens.slice(0, insertAt), ...newTokens, ...tokens.slice(insertAt)];
    setShowDraft(false);
    setDraftInput('');
    commitTokens(next, insertAt + newTokens.length);
  }, [tokens, commitTokens]);

  // ---------------------------------------------------------------------------
  // Token mutators.

  const removeTokenAt = useCallback((idx: number) => {
    if (idx < 0 || idx >= tokens.length) return;
    const next = [...tokens.slice(0, idx), ...tokens.slice(idx + 1)];
    commitTokens(next, idx);
  }, [tokens, commitTokens]);

  const updateToken = useCallback((id: string, patch: Partial<FlatToken>) => {
    const next = tokens.map(t => (t.id === id ? ({ ...t, ...patch } as FlatToken) : t));
    commitTokens(next);
  }, [tokens, commitTokens]);

  const insertTokenAtCaret = useCallback((tok: FlatToken | FlatToken[], advance = 1) => {
    const arr = Array.isArray(tok) ? tok : [tok];
    const next = [...tokens.slice(0, caret), ...arr, ...tokens.slice(caret)];
    commitTokens(next, caret + advance);
  }, [tokens, caret, commitTokens]);

  // ---------------------------------------------------------------------------
  // Container key handling.

  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingId || showDraft) return; // chip-edit / draft-input handles its own keys
    const isMeta = e.metaKey || e.ctrlKey;

    if (e.key === 'ArrowLeft') {
      if (isMeta) setCaret(0); else setCaret(c => Math.max(0, c - 1));
      e.preventDefault(); return;
    }
    if (e.key === 'ArrowRight') {
      if (isMeta) setCaret(tokens.length); else setCaret(c => Math.min(tokens.length, c + 1));
      e.preventDefault(); return;
    }
    if (e.key === 'Home') { setCaret(0); e.preventDefault(); return; }
    if (e.key === 'End') { setCaret(tokens.length); e.preventDefault(); return; }
    if (e.key === 'Tab') {
      if (e.shiftKey) setCaret(c => Math.max(0, c - 1));
      else setCaret(c => Math.min(tokens.length, c + 1));
      e.preventDefault(); return;
    }
    if (e.key === 'Backspace') {
      if (caret > 0) removeTokenAt(caret - 1);
      e.preventDefault(); return;
    }
    if (e.key === 'Delete') {
      if (caret < tokens.length) removeTokenAt(caret);
      e.preventDefault(); return;
    }
    if (e.key === 'Enter') {
      if (caret === tokens.length && onSubmit) { onSubmit(); e.preventDefault(); return; }
    }
    // Printable character → open draft input.
    if (e.key.length === 1 && !e.altKey && !e.metaKey && !e.ctrlKey) {
      setShowDraft(true);
      setDraftInput(e.key);
      e.preventDefault();
      // Focus the input on next tick.
      requestAnimationFrame(() => draftInputRef.current?.focus());
      return;
    }
  }, [caret, tokens.length, editingId, showDraft, removeTokenAt, onSubmit]);

  // ---------------------------------------------------------------------------
  // Draft input — typed mid-stream.

  const handleDraftKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setShowDraft(false); setDraftInput('');
      e.preventDefault(); return;
    }
    // Auto-commit on operator keywords as soon as typed (whole-word match).
    if (e.key === ' ' || e.key === 'Enter' || e.key === ')') {
      // Special: trailing `)` should commit current value then add rparen.
      const val = draftInput;
      const upper = val.trim().toUpperCase();
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
        const opKind = upper.toLowerCase() as 'and' | 'or' | 'not';
        const next = [...tokens.slice(0, caret), { id: newId(), kind: opKind } as FlatToken, ...tokens.slice(caret)];
        setShowDraft(false); setDraftInput('');
        commitTokens(next, caret + 1);
        e.preventDefault(); return;
      }
      if (e.key === ')') {
        const before = stringToTokens(val);
        const next = [...tokens.slice(0, caret), ...before, { id: newId(), kind: 'rparen' } as FlatToken, ...tokens.slice(caret)];
        setShowDraft(false); setDraftInput('');
        commitTokens(next, caret + before.length + 1);
        e.preventDefault(); return;
      }
      if (e.key === 'Enter' && val.trim() === '' && onSubmit) { onSubmit(); e.preventDefault(); return; }
      commitDraftInput(val, caret);
      e.preventDefault(); return;
    }
    if (e.key === 'Backspace' && draftInput === '') {
      setShowDraft(false);
      if (caret > 0) removeTokenAt(caret - 1);
      e.preventDefault(); return;
    }
  }, [draftInput, tokens, caret, commitTokens, commitDraftInput, removeTokenAt, onSubmit]);

  // ---------------------------------------------------------------------------
  // Inline edit handlers for term chips.

  const startEdit = useCallback((id: string) => {
    setEditingId(id);
  }, []);

  const finishEdit = useCallback((id: string, newValue: string) => {
    const tok = tokens.find(t => t.id === id);
    if (!tok || tok.kind !== 'term') { setEditingId(null); return; }
    if (newValue.trim() === '' && !tok.field) {
      // Empty bare term → remove
      const idx = tokens.findIndex(t => t.id === id);
      setEditingId(null);
      if (idx >= 0) removeTokenAt(idx);
      return;
    }
    updateToken(id, { value: newValue });
    setEditingId(null);
  }, [tokens, updateToken, removeTokenAt]);

  // ---------------------------------------------------------------------------
  // Toolbar handlers.

  const onInsertOp = (kind: 'and' | 'or' | 'not') =>
    insertTokenAtCaret({ id: newId(), kind });
  const onInsertParens = () => {
    const left: FlatToken = { id: newId(), kind: 'lparen' };
    const right: FlatToken = { id: newId(), kind: 'rparen' };
    insertTokenAtCaret([left, right], 1);
  };
  const onInsertPhrase = () => {
    const t: FlatToken = { id: newId(), kind: 'term', value: '', phrase: true };
    insertTokenAtCaret(t, 1);
    setEditingId(t.id);
  };
  const onInsertField = () => {
    const field = fieldNames[0] ?? 'case';
    const t: FlatToken = { id: newId(), kind: 'term', value: '', field, phrase: false };
    insertTokenAtCaret(t, 1);
    setFieldDropdownChipId(t.id);
    setEditingId(t.id);
  };

  // ---------------------------------------------------------------------------
  // Source-view textarea.

  const toggleSourceView = () => {
    const next = !sourceView;
    setSourceView(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('boolean-composer-source-view', next ? '1' : '0');
    }
  };

  // ---------------------------------------------------------------------------
  // Error-aware highlighting: which chip covers the parse error position?
  // We re-tokenize current string and walk byte positions to find the token
  // whose span contains parseResult.position; map back to the matching chip by
  // index (cheap heuristic — matches in token-position order).
  const errorChipIndex: number | null = useMemo(() => {
    if (parseResult.ok || midTyping) return null;
    // We don't have per-token positions from stringToTokens; approximate by
    // serializing prefixes until the cumulative length exceeds the error pos.
    const errPos = parseResult.position;
    let acc = 0;
    for (let i = 0; i < tokens.length; i++) {
      const part = tokensToString([tokens[i]]);
      const span = part.length + 1; // +1 for the join space
      if (acc + span > errPos) return i;
      acc += span;
    }
    return tokens.length - 1;
  }, [parseResult, midTyping, tokens]);

  // ---------------------------------------------------------------------------
  // Render — source view.

  if (sourceView) {
    return (
      <div className="w-full">
        <div className="flex items-center justify-end mb-1">
          <button
            type="button"
            onClick={toggleSourceView}
            className="text-[10px] px-2 py-0.5 border border-gray-300 bg-white rounded hover:bg-gray-50 text-gray-700"
          >
            Chip view
          </button>
        </div>
        <textarea
          value={value}
          onChange={e => {
            lastEmittedRef.current = e.target.value;
            onChange(e.target.value);
            setTokens(stringToTokens(e.target.value));
          }}
          placeholder={placeholder}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono"
          rows={2}
        />
        {renderParsePill(parseResult, midTyping, summary)}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — chip view.

  return (
    <div className="w-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
        <button type="button" onClick={() => onInsertOp('and')}
          className="text-[10px] font-semibold px-2 py-0.5 border border-blue-300 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
          aria-label="Insert AND">AND</button>
        <button type="button" onClick={() => onInsertOp('or')}
          className="text-[10px] font-semibold px-2 py-0.5 border border-purple-300 bg-purple-100 text-purple-700 rounded hover:bg-purple-200"
          aria-label="Insert OR">OR</button>
        <button type="button" onClick={() => onInsertOp('not')}
          className="text-[10px] font-semibold px-2 py-0.5 border border-red-300 bg-red-100 text-red-700 rounded hover:bg-red-200"
          aria-label="Insert NOT">NOT</button>
        <button type="button" onClick={onInsertParens}
          className="text-[10px] font-mono px-2 py-0.5 border border-gray-300 bg-white rounded hover:bg-gray-50 text-gray-700"
          aria-label="Insert parentheses">( )</button>
        <button type="button" onClick={onInsertPhrase}
          className="text-[10px] font-mono px-2 py-0.5 border border-gray-300 bg-white rounded hover:bg-gray-50 text-gray-700 inline-flex items-center gap-0.5"
          aria-label="Insert phrase"><QuoteIcon className="w-3 h-3" />…</button>
        <button type="button" onClick={onInsertField}
          className="text-[10px] font-mono px-2 py-0.5 border border-sky-300 bg-sky-50 text-sky-700 rounded hover:bg-sky-100"
          aria-label="Insert field term">Field:</button>
        <div className="ml-auto" />
        <button type="button" onClick={toggleSourceView}
          className="text-[10px] px-2 py-0.5 border border-gray-300 bg-white rounded hover:bg-gray-50 text-gray-700"
          aria-label="Toggle source view">Source view</button>
      </div>

      {/* Live region for caret position (sr-only) */}
      <span className="sr-only" aria-live="polite">
        {focused ? describeCaret(tokens, caret) : ''}
      </span>

      {/* Composer container */}
      <div
        ref={containerRef}
        role="textbox"
        aria-multiline="false"
        aria-label="Boolean query composer"
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          // Don't blur if focus moved inside the composer.
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setFocused(false);
        }}
        onKeyDown={handleContainerKeyDown}
        onClick={(e) => {
          // Clicking blank space focuses the container and moves caret to end.
          if (e.target === e.currentTarget) {
            setCaret(tokens.length);
            containerRef.current?.focus();
          }
        }}
        className={`flex flex-wrap content-start items-center gap-1 px-2 py-1.5 border rounded-lg bg-white min-h-[40px] cursor-text ${
          focused ? 'border-purple-400 ring-2 ring-purple-500/30' : 'border-gray-300'
        }`}
      >
        {tokens.length === 0 && !showDraft && (
          <span className="text-xs text-gray-400 px-1 select-none pointer-events-none">{placeholder}</span>
        )}

        {tokens.map((tok, idx) => {
          const isErr = errorChipIndex === idx;
          const isParenMatch =
            (hoveredParen === idx || matchedParen === idx) && (tok.kind === 'lparen' || tok.kind === 'rparen');
          return (
            <React.Fragment key={tok.id}>
              <CaretSlot show={focused && caret === idx} />
              {renderChip(tok, {
                editing: editingId === tok.id,
                fieldDropdownOpen: fieldDropdownChipId === tok.id,
                fieldNames,
                isError: isErr,
                errorMessage: isErr && !parseResult.ok ? parseResult.error : undefined,
                isParenMatch,
                onHoverParen: () => setHoveredParen(idx),
                onLeaveParen: () => setHoveredParen(null),
                onStartEdit: () => startEdit(tok.id),
                onFinishEdit: (v: string) => finishEdit(tok.id, v),
                onCancelEdit: () => setEditingId(null),
                onRemove: () => removeTokenAt(idx),
                onToggleFieldDropdown: () => setFieldDropdownChipId(fieldDropdownChipId === tok.id ? null : tok.id),
                onChangeField: (f: string) => {
                  updateToken(tok.id, { field: f } as Partial<FlatToken>);
                  setFieldDropdownChipId(null);
                },
              })}
            </React.Fragment>
          );
        })}
        <CaretSlot show={focused && caret === tokens.length && !showDraft} />

        {showDraft && caret === tokens.length && (
          <DraftInput
            inputRef={draftInputRef}
            value={draftInput}
            onChange={setDraftInput}
            onKeyDown={handleDraftKey}
            onBlur={() => {
              if (draftInput.trim()) commitDraftInput(draftInput, caret);
              else { setShowDraft(false); setDraftInput(''); }
            }}
          />
        )}
      </div>

      {renderParsePill(parseResult, midTyping, summary)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers / sub-components.

function describeCaret(tokens: FlatToken[], caret: number): string {
  const summarize = (t: FlatToken | undefined): string => {
    if (!t) return '';
    if (t.kind === 'term') return `${t.field ? t.field + ':' : ''}${t.value || '(empty)'}`;
    if (t.kind === 'and') return 'AND';
    if (t.kind === 'or') return 'OR';
    if (t.kind === 'not') return 'NOT';
    if (t.kind === 'lparen') return '(';
    return ')';
  };
  const left = caret > 0 ? summarize(tokens[caret - 1]) : 'start';
  const right = caret < tokens.length ? summarize(tokens[caret]) : 'end';
  return `Caret at position ${caret}, between ${left} and ${right}`;
}

function CaretSlot({ show }: { show: boolean }) {
  if (!show) return <span className="w-0" aria-hidden="true" />;
  return <span className="inline-block w-px h-4 bg-purple-600 animate-pulse" aria-hidden="true" />;
}

function renderParsePill(
  parseResult: ReturnType<typeof parseBooleanQuery>,
  midTyping: boolean,
  summary: { terms: number; ops: number } | null,
) {
  return (
    <div className="mt-1 flex items-center">
      {parseResult.ok && summary && (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 bg-green-50 border border-green-200 text-green-700 rounded">
          <span className="w-1 h-1 rounded-full bg-green-500" />
          boolean parsed: {summary.terms} term{summary.terms === 1 ? '' : 's'} / {summary.ops} operator{summary.ops === 1 ? '' : 's'}
        </span>
      )}
      {!parseResult.ok && midTyping && (
        <span className="inline-block text-[10px] font-mono px-2 py-0.5 border border-gray-200 bg-gray-50 text-gray-500 rounded">incomplete…</span>
      )}
      {!parseResult.ok && !midTyping && (
        <span className="inline-block text-[10px] font-mono px-2 py-0.5 border border-red-200 bg-red-50 text-red-700 rounded">
          {parseResult.error} (col {parseResult.position + 1})
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// renderChip — dispatches to chip-flavor renderers.

type ChipHandlers = {
  editing: boolean;
  fieldDropdownOpen: boolean;
  fieldNames: string[];
  isError: boolean;
  errorMessage?: string;
  isParenMatch: boolean;
  onHoverParen: () => void;
  onLeaveParen: () => void;
  onStartEdit: () => void;
  onFinishEdit: (v: string) => void;
  onCancelEdit: () => void;
  onRemove: () => void;
  onToggleFieldDropdown: () => void;
  onChangeField: (f: string) => void;
};

function renderChip(tok: FlatToken, h: ChipHandlers) {
  const errRing = h.isError ? 'ring-2 ring-red-400' : '';
  const title = h.errorMessage ?? '';

  if (tok.kind === 'and') {
    return (
      <button type="button" onClick={h.onRemove} title={title || 'AND (click to remove)'}
        aria-label="AND operator. Click to remove."
        className={`inline-flex items-center text-[10px] font-semibold uppercase px-2 py-0.5 border border-blue-300 bg-blue-100 text-blue-700 rounded ${errRing}`}>
        AND
      </button>
    );
  }
  if (tok.kind === 'or') {
    return (
      <button type="button" onClick={h.onRemove} title={title || 'OR (click to remove)'}
        aria-label="OR operator. Click to remove."
        className={`inline-flex items-center text-[10px] font-semibold uppercase px-2 py-0.5 border border-purple-300 bg-purple-100 text-purple-700 rounded ${errRing}`}>
        OR
      </button>
    );
  }
  if (tok.kind === 'not') {
    return (
      <button type="button" onClick={h.onRemove} title={title || 'NOT (click to remove)'}
        aria-label="NOT operator. Click to remove."
        className={`inline-flex items-center text-[10px] font-semibold uppercase px-2 py-0.5 border border-red-300 bg-red-100 text-red-700 rounded ${errRing}`}>
        NOT
      </button>
    );
  }
  if (tok.kind === 'lparen' || tok.kind === 'rparen') {
    const matchBg = h.isParenMatch ? 'bg-amber-100 border-amber-400' : 'bg-gray-50 border-gray-300';
    return (
      <button type="button" onClick={h.onRemove}
        onMouseEnter={h.onHoverParen} onMouseLeave={h.onLeaveParen}
        title={title || `${tok.kind === 'lparen' ? 'Open' : 'Close'} paren (click to remove)`}
        aria-label={`${tok.kind === 'lparen' ? 'Open' : 'Close'} paren. Click to remove.`}
        className={`inline-flex items-center text-xs font-mono px-1.5 py-0.5 border rounded text-gray-700 ${matchBg} ${errRing}`}>
        {tok.kind === 'lparen' ? '(' : ')'}
      </button>
    );
  }

  // term / phrase / field-term
  if (tok.kind !== 'term') return null;
  if (tok.field !== undefined) {
    return <FieldTermChip tok={tok} h={h} errRing={errRing} title={title} />;
  }
  return <PlainTermChip tok={tok} h={h} errRing={errRing} title={title} />;
}

function PlainTermChip({
  tok, h, errRing, title,
}: {
  tok: Extract<FlatToken, { kind: 'term' }>;
  h: ChipHandlers;
  errRing: string;
  title: string;
}) {
  const [draft, setDraft] = useState(tok.value);
  useEffect(() => { if (h.editing) setDraft(tok.value); }, [h.editing, tok.value]);

  if (h.editing) {
    return (
      <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 text-xs border rounded-md bg-white border-purple-400 ring-1 ring-purple-300 ${errRing}`}>
        {tok.phrase && <QuoteIcon className="w-3 h-3 text-gray-400" />}
        {tok.phrase && <span className="text-gray-500">&quot;</span>}
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => h.onFinishEdit(draft)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); h.onFinishEdit(draft); }
            else if (e.key === 'Escape') { e.preventDefault(); h.onCancelEdit(); }
          }}
          className="bg-transparent outline-none border-0 min-w-[3ch] text-xs"
          style={{ width: `${Math.max(3, draft.length + 1)}ch` }}
        />
        {tok.phrase && <span className="text-gray-500">&quot;</span>}
      </span>
    );
  }

  return (
    <button type="button" onClick={h.onStartEdit}
      title={title || `Term: ${tok.value}. Click to edit.`}
      aria-label={`${tok.phrase ? 'Phrase' : 'Term'}: ${tok.value}. Press Enter to edit, Delete to remove.`}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs border rounded-md bg-white border-gray-300 hover:border-gray-400 text-gray-800 ${errRing}`}>
      {tok.phrase && <QuoteIcon className="w-3 h-3 text-gray-400" />}
      <span className="font-mono">
        {tok.phrase ? `"${tok.value}"` : tok.value}
      </span>
      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); h.onRemove(); }}
        className="opacity-50 hover:opacity-100"
        aria-label="Remove"
      >
        <CloseIcon className="w-3 h-3" />
      </span>
    </button>
  );
}

function FieldTermChip({
  tok, h, errRing, title,
}: {
  tok: Extract<FlatToken, { kind: 'term' }>;
  h: ChipHandlers;
  errRing: string;
  title: string;
}) {
  const [draft, setDraft] = useState(tok.value);
  useEffect(() => { if (h.editing) setDraft(tok.value); }, [h.editing, tok.value]);

  return (
    <span className={`inline-flex items-center text-xs border rounded-md bg-sky-50 border-sky-300 text-sky-900 ${errRing}`}>
      {/* Field segment */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); h.onToggleFieldDropdown(); }}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 hover:bg-sky-100 rounded-l-md"
        title={`Field: ${tok.field}`}
        aria-label={`Field ${tok.field}. Click to change.`}
      >
        <span className="font-mono">{tok.field}</span>
        <CaretIcon className="w-2 h-2 opacity-60" />
      </button>
      <span className="border-l border-sky-300 h-4" aria-hidden="true" />
      {/* Value segment */}
      {h.editing ? (
        <span className="inline-flex items-center px-1.5 py-0.5 bg-white">
          {tok.phrase && <span className="text-gray-500">&quot;</span>}
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => h.onFinishEdit(draft)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); h.onFinishEdit(draft); }
              else if (e.key === 'Escape') { e.preventDefault(); h.onCancelEdit(); }
            }}
            className="bg-transparent outline-none border-0 text-xs"
            style={{ width: `${Math.max(3, draft.length + 1)}ch` }}
            placeholder="value"
          />
          {tok.phrase && <span className="text-gray-500">&quot;</span>}
        </span>
      ) : (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); h.onStartEdit(); }}
          title={title || `Field term: ${tok.field}=${tok.value}. Click to edit.`}
          aria-label={`Field term: ${tok.field} equals ${tok.value || '(empty)'}. Press Enter to edit, Delete to remove.`}
          className="inline-flex items-center px-1.5 py-0.5 hover:bg-sky-100 font-mono"
        >
          {tok.phrase ? `"${tok.value}"` : (tok.value || <span className="italic opacity-60">value</span>)}
        </button>
      )}
      <span className="border-l border-sky-300 h-4" aria-hidden="true" />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); h.onRemove(); }}
        className="px-1.5 py-0.5 opacity-50 hover:opacity-100 rounded-r-md"
        aria-label="Remove field term"
      >
        <CloseIcon className="w-3 h-3" />
      </button>

      {/* Field dropdown */}
      {h.fieldDropdownOpen && h.fieldNames.length > 0 && (
        <span className="relative">
          <span className="absolute left-0 top-5 z-10 bg-white border border-gray-300 rounded shadow-md min-w-[140px] py-1">
            {h.fieldNames.map(f => (
              <button
                key={f}
                type="button"
                onClick={(e) => { e.stopPropagation(); h.onChangeField(f); }}
                className={`block w-full text-left px-2 py-1 text-xs font-mono hover:bg-sky-50 ${f === tok.field ? 'bg-sky-50 text-sky-700' : 'text-gray-700'}`}
              >
                {f}
              </button>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}

function DraftInput({
  inputRef, value, onChange, onKeyDown, onBlur,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
}) {
  return (
    <input
      ref={inputRef}
      autoFocus
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      placeholder="type term, AND/OR/NOT, field:value, or &quot;phrase&quot;"
      className="flex-1 min-w-[160px] bg-transparent outline-none border-0 text-xs px-1 py-0.5"
    />
  );
}
