'use client';

import React from 'react';
import {
  CATALOGUE,
  FEATURED_EXAMPLES,
  OPERATORS,
  BOOLEANS,
  type FieldType,
} from './filter-logic-catalogue';

// ---------------------------------------------------------------------------
// isLikelyMidTyping — exported for testing.
//
// Returns true when a failed parse is plausibly a transient mid-typing state
// (trailing operator, leading OR/AND, operator-only input) rather than a real
// syntax error. Callers should render a muted "incomplete…" pill in this case
// and reserve the red error bar for genuine problems like mismatched parens.
// ---------------------------------------------------------------------------
export function isLikelyMidTyping(input: string, _errorPos: number): boolean {
  if (!input.trim()) return true;
  // trailing operator (lowercase only — uppercase is a real parse error post-#55)
  if (/(?:^|\s)(and|or|not|-|\()\s*$/.test(input)) return true;
  // leading or/and
  if (/^\s*(and|or)\b/.test(input)) return true;
  // operator/paren-only
  if (/^[\s()\-]*(and|or|not)?[\s()\-]*$/.test(input)) return true;
  // Trailing Axon-op without a value (mid-typing `case==`, `motionType>=`).
  if (/[A-Za-z0-9_)](==|!=|>=|<=|>|<)\s*$/.test(input)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// FilterLogicPanel
//
// Catalogue-driven reference for the Axon query syntax. All field metadata
// comes from `filter-logic-catalogue.ts`, which mirrors the XETO interfaces
// in `src/lib/legal/types.ts`. No hand-written prose lives in this file.
// ---------------------------------------------------------------------------

type Props = {
  onInsertExample: (text: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

function ChevronLeft({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

const TYPE_CHIP_CLASS: Record<FieldType, string> = {
  string: 'bg-gray-100 text-gray-600',
  date:   'bg-blue-50 text-blue-700',
  number: 'bg-emerald-50 text-emerald-700',
  ref:    'bg-violet-50 text-violet-700',
  marker: 'bg-amber-50 text-amber-700',
};

function TypeChip({ type }: { type: FieldType }) {
  return (
    <span
      className={`ml-1 px-1 py-px text-[9px] uppercase tracking-wider rounded ${TYPE_CHIP_CLASS[type]}`}
    >
      {type}
    </span>
  );
}

function TokenPill({ label, onClick, title }: { label: string; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white border border-gray-200 text-gray-700 hover:bg-gray-100 hover:border-gray-300"
    >
      {label}
    </button>
  );
}

export function FilterLogicPanel({ onInsertExample, collapsed = false, onToggleCollapsed }: Props): React.JSX.Element {
  if (collapsed) {
    return (
      <aside
        role="complementary"
        aria-label="Filter logic reference"
        className="flex-shrink-0 border-r border-gray-200 bg-gray-50/80 flex flex-col items-center"
        style={{ width: 32 }}
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="mt-2 p-1 rounded hover:bg-gray-200 text-gray-500"
          aria-label="Expand filter logic panel"
          title="Expand"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        {/* Sideways title — readable along the collapsed rail so users can
            see what the minimized strip is. Clicking it also expands. */}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand filter logic panel"
          title="Expand"
          className="mt-3 select-none text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-700"
          style={{
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            letterSpacing: '0.1em',
          }}
        >
          Filter Logic
        </button>
      </aside>
    );
  }

  return (
    <aside
      role="complementary"
      aria-label="Filter logic reference"
      className="flex-shrink-0 border-r border-gray-200 bg-gray-50/80 flex flex-col overflow-y-auto"
      style={{ width: 260 }}
    >
      <div className="flex items-center justify-between p-3 border-b border-gray-200">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Filter Logic</h3>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="p-1 rounded hover:bg-gray-200 text-gray-500"
          aria-label="Collapse filter logic panel"
          title="Collapse"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3 space-y-4 text-xs text-gray-700">
        {/* Operators toolbar */}
        <section>
          <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Operators
          </h4>
          <div className="flex flex-wrap gap-1">
            {OPERATORS.map((op) => (
              <TokenPill key={op.token} label={op.token} onClick={() => onInsertExample(op.insert)} />
            ))}
            <span className="mx-1 text-gray-300">|</span>
            {BOOLEANS.map((op) => (
              <TokenPill key={op.token} label={op.token} onClick={() => onInsertExample(op.insert)} />
            ))}
          </div>
        </section>

        {/* Catalogue sections */}
        {CATALOGUE.map((section) => (
          <section key={section.marker}>
            <div className="flex items-baseline gap-1.5 mb-1.5">
              <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                {section.name}
              </h4>
              <code className="text-[9px] px-1 py-px rounded bg-gray-100 text-gray-500 font-mono">
                {section.marker}
              </code>
            </div>
            <ul className="space-y-0.5">
              {section.fields.map((f) => (
                <li key={f.name}>
                  <button
                    type="button"
                    onClick={() => onInsertExample(f.example)}
                    title={f.example}
                    className="w-full text-left flex items-center px-1 py-0.5 rounded hover:bg-gray-100 group"
                  >
                    <code className="font-mono text-[10px] text-gray-700 truncate">{f.name}</code>
                    <TypeChip type={f.type} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {/* Featured examples */}
        <section>
          <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Examples
          </h4>
          <div className="flex flex-col gap-1">
            {FEATURED_EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => onInsertExample(ex)}
                className="text-left px-1.5 py-1 font-mono text-[10px] bg-purple-50 border border-purple-200 text-purple-700 rounded hover:bg-purple-100 truncate"
                title={ex}
              >
                {ex}
              </button>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}
