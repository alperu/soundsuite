'use client';

import React from 'react';

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
  // trailing operator
  if (/(?:^|\s)(and|or|not|AND|OR|NOT|-|\()\s*$/.test(input)) return true;
  // leading or/and
  if (/^\s*(and|or|AND|OR)\b/.test(input)) return true;
  // operator/paren-only
  if (/^[\s()\-]*(and|or|not|AND|OR|NOT)?[\s()\-]*$/.test(input)) return true;
  // Trailing Axon-op without a value (mid-typing `case==`, `motionType>=`).
  if (/[A-Za-z0-9_)](==|!=|>=|<=|>|<)\s*$/.test(input)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// FilterLogicPanel
//
// Left-rail reference for boolean-query syntax. Pure presentational —
// collapsed state is owned by the parent (persisted to localStorage under
// "filter-logic-panel-collapsed").
// ---------------------------------------------------------------------------

type Props = {
  onInsertExample: (text: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

const EXAMPLES: string[] = [
  '(motion and compel) or appeal',
  'case=="23-CV-1234" and motionType=="disqualification"',
  'pageCount >= 10 and filingType=="RR"',
  '"order denying" -dismissed',
];

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
        <p className="text-[11px] text-gray-600 leading-snug">
          Syntax is Axon — lowercase keywords, <code className="bg-gray-100 px-0.5 rounded">==</code> for equality.
        </p>

        {/* Boolean operators */}
        <section>
          <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Boolean operators</h4>
          <ul className="space-y-1 text-[11px] leading-relaxed">
            <li><code className="bg-gray-100 px-1 rounded">a and b</code> — both terms match</li>
            <li><code className="bg-gray-100 px-1 rounded">a or b</code> — either term matches</li>
            <li><code className="bg-gray-100 px-1 rounded">not b</code> or <code className="bg-gray-100 px-1 rounded">-foo</code> — exclude</li>
            <li><code className="bg-gray-100 px-1 rounded">(a and b) or c</code> — group with parens</li>
          </ul>
        </section>

        {/* Phrases */}
        <section>
          <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Phrases</h4>
          <ul className="space-y-1 text-[11px] leading-relaxed">
            <li><code className="bg-gray-100 px-1 rounded">&quot;motion to compel&quot;</code> — exact phrase</li>
            <li>Escape an internal quote with <code className="bg-gray-100 px-1 rounded">\&quot;</code></li>
          </ul>
        </section>

        {/* Field comparisons (Axon-style) */}
        <section>
          <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Field comparisons
          </h4>
          <ul className="space-y-1 text-[11px] leading-relaxed">
            <li><code className="bg-gray-100 px-1 rounded">case==&quot;23-CV-1234&quot;</code></li>
            <li><code className="bg-gray-100 px-1 rounded">filingType==&quot;RR&quot;</code></li>
            <li><code className="bg-gray-100 px-1 rounded">documentType==&quot;order denying&quot;</code></li>
            <li><code className="bg-gray-100 px-1 rounded">pageCount &gt;= 10</code></li>
            <li><code className="bg-gray-100 px-1 rounded">filingDate &gt; 2026-01-01</code></li>
          </ul>
          <p className="text-[10px] text-gray-500 mt-1 leading-snug">
            Operators: <code className="bg-gray-100 px-0.5 rounded">==</code>{' '}
            <code className="bg-gray-100 px-0.5 rounded">!=</code>{' '}
            <code className="bg-gray-100 px-0.5 rounded">&gt;=</code>{' '}
            <code className="bg-gray-100 px-0.5 rounded">&lt;=</code>{' '}
            <code className="bg-gray-100 px-0.5 rounded">&gt;</code>{' '}
            <code className="bg-gray-100 px-0.5 rounded">&lt;</code>
          </p>
          <p className="text-[10px] text-gray-500 mt-1 leading-snug">
            Fields: <code className="bg-gray-100 px-0.5 rounded">case</code>,{' '}
            <code className="bg-gray-100 px-0.5 rounded">caseId</code>,{' '}
            <code className="bg-gray-100 px-0.5 rounded">filingType</code>,{' '}
            <code className="bg-gray-100 px-0.5 rounded">documentType</code>,{' '}
            <code className="bg-gray-100 px-0.5 rounded">motionType</code>.
            Unknown fields fall back to bare text. Field filters under an{' '}
            <code className="bg-gray-100 px-0.5 rounded">or</code> branch currently degrade to text match.
          </p>
        </section>

        {/* Refs */}
        <section>
          <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Refs</h4>
          <ul className="space-y-1 text-[11px] leading-relaxed">
            <li><code className="bg-gray-100 px-1 rounded">caseRef==@04a8cd94-359c-4feb-…</code></li>
            <li><code className="bg-gray-100 px-1 rounded">filingRef==@&lt;filing-uuid&gt;</code></li>
          </ul>
          <p className="text-[10px] text-gray-500 mt-1 leading-snug">
            <code className="bg-gray-100 px-0.5 rounded">@id</code> is a typed reference — strictly identity, no fuzzy match.
          </p>
        </section>

        {/* Examples */}
        <section>
          <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Examples</h4>
          <div className="flex flex-col gap-1">
            {EXAMPLES.map(ex => (
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

        {/* Precedence cheat sheet */}
        <section>
          <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Precedence</h4>
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-0.5 pr-2 font-medium">Op</th>
                <th className="py-0.5 pr-2 font-medium">Binds</th>
                <th className="py-0.5 font-medium">Example</th>
              </tr>
            </thead>
            <tbody className="font-mono text-gray-700">
              <tr className="border-t border-gray-200">
                <td className="py-0.5 pr-2">not</td>
                <td className="py-0.5 pr-2">tightest</td>
                <td className="py-0.5">not a</td>
              </tr>
              <tr className="border-t border-gray-200">
                <td className="py-0.5 pr-2">and</td>
                <td className="py-0.5 pr-2">middle</td>
                <td className="py-0.5">a and b</td>
              </tr>
              <tr className="border-t border-gray-200">
                <td className="py-0.5 pr-2">or</td>
                <td className="py-0.5 pr-2">loosest</td>
                <td className="py-0.5">a or b</td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* Mid-typing note */}
        <section className="border-t border-gray-200 pt-3">
          <p className="text-[10px] text-gray-500 leading-snug">
            Trailing <code className="bg-gray-100 px-0.5 rounded">and</code> /{' '}
            <code className="bg-gray-100 px-0.5 rounded">or</code> is treated as incomplete, not an error.
            Red bar appears only for real syntax problems like mismatched parens
            or legacy <code className="bg-gray-100 px-0.5 rounded">field:value</code> (use <code className="bg-gray-100 px-0.5 rounded">==</code>).
          </p>
        </section>
      </div>
    </aside>
  );
}
