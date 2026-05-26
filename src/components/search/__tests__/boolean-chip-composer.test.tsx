/**
 * @jest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import BooleanChipComposer, {
  stringToTokens,
  tokensToString,
  FlatToken,
} from '../boolean-chip-composer';
import { parseBooleanQuery, astSerialize } from '@/lib/search/boolean-query';

function kinds(tokens: FlatToken[]): string[] {
  return tokens.map(t => (t.kind === 'term'
    ? (t.field
        ? `field:${t.field}=${t.phrase ? '"' + t.value + '"' : t.value}`
        : (t.phrase ? `phrase:"${t.value}"` : `term:${t.value}`))
    : t.kind));
}

describe('stringToTokens', () => {
  it('parses (motion and compel) or appeal into 7 tokens', () => {
    const toks = stringToTokens('(motion and compel) or appeal');
    expect(kinds(toks)).toEqual([
      'lparen', 'term:motion', 'and', 'term:compel', 'rparen', 'or', 'term:appeal',
    ]);
  });

  it('round-trips through tokensToString → parseBooleanQuery', () => {
    const inputs = [
      '(motion and compel) or appeal',
      'case==23-CV-1234 and motionType==disqualification',
      '"order denying" -dismissed',
      'appeal or petition',
    ];
    for (const inp of inputs) {
      const toks = stringToTokens(inp);
      const round = tokensToString(toks);
      const origAst = parseBooleanQuery(inp);
      const roundAst = parseBooleanQuery(round);
      expect(origAst.ok).toBe(true);
      expect(roundAst.ok).toBe(true);
      if (origAst.ok && roundAst.ok) {
        expect(astSerialize(origAst.ast)).toBe(astSerialize(roundAst.ast));
      }
    }
  });

  it('tokenizes a field-qualified phrase', () => {
    const toks = stringToTokens('documentType:"order denying"');
    expect(toks).toHaveLength(1);
    const t = toks[0];
    if (t.kind === 'term') {
      expect(t.field).toBe('documentType');
      expect(t.phrase).toBe(true);
      expect(t.value).toBe('order denying');
    } else {
      throw new Error('expected term');
    }
  });

  it('handles bare phrase', () => {
    const toks = stringToTokens('"motion to compel"');
    expect(toks).toHaveLength(1);
    const t = toks[0];
    if (t.kind === 'term') {
      expect(t.phrase).toBe(true);
      expect(t.value).toBe('motion to compel');
    } else {
      throw new Error('expected term');
    }
  });

  it('tokenizes field:value bare term', () => {
    const toks = stringToTokens('case:23-CV-1234');
    expect(toks).toHaveLength(1);
    if (toks[0].kind === 'term') {
      expect(toks[0].field).toBe('case');
      expect(toks[0].value).toBe('23-CV-1234');
    }
  });

  it('tokenizes ( motion ) into three tokens', () => {
    const toks = stringToTokens('( motion )');
    expect(toks.map(t => t.kind)).toEqual(['lparen', 'term', 'rparen']);
  });
});

// ---------------------------------------------------------------------------
// Component tests — minimal DOM driver, no @testing-library/* needed.

describe('BooleanChipComposer (DOM)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onChange: jest.Mock;
  let onSubmit: jest.Mock;

  function mount(initial = '') {
    onChange = jest.fn((s: string) => { /* parent would setState; we re-render below */ });
    onSubmit = jest.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <BooleanChipComposer
          value={initial}
          onChange={onChange}
          onSubmit={onSubmit}
          fieldNames={['case', 'caseNumber', 'documentType']}
          autoFocus
        />,
      );
    });
  }

  function unmount() {
    act(() => { root.unmount(); });
    container.remove();
  }

  function findBox(): HTMLElement {
    const el = container.querySelector('[role="textbox"]') as HTMLElement;
    if (!el) throw new Error('composer textbox not found');
    return el;
  }

  function findButtonByLabel(label: string): HTMLButtonElement {
    const btn = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
    if (!btn) throw new Error(`button "${label}" not found`);
    return btn;
  }

  function click(el: HTMLElement) {
    act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }

  function keydown(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    act(() => {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      el.dispatchEvent(ev);
    });
  }

  afterEach(() => { try { unmount(); } catch { /* */ } });

  it('clicking AND toolbar inserts an and chip', () => {
    mount('motion compel');
    click(findButtonByLabel('Insert AND'));
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0];
    expect(last).toMatch(/\band\b/);
  });

  it('clicking OR / NOT / parens insert their chips', () => {
    mount('a b');
    click(findButtonByLabel('Insert OR'));
    expect(onChange.mock.calls.at(-1)![0]).toMatch(/\bor\b/);
    click(findButtonByLabel('Insert NOT'));
    expect(onChange.mock.calls.at(-1)![0]).toMatch(/\bnot\b/);
    click(findButtonByLabel('Insert parentheses'));
    expect(onChange.mock.calls.at(-1)![0]).toMatch(/\(.*\)/);
  });

  it('Backspace at end of composer removes the last chip', () => {
    mount('motion and compel');
    const box = findBox();
    act(() => { box.focus(); });
    keydown(box, 'Backspace');
    const last = onChange.mock.calls.at(-1)![0];
    expect(last).not.toMatch(/compel/);
  });

  it('arrow keys move caret without crashing', () => {
    mount('a b c');
    const box = findBox();
    act(() => { box.focus(); });
    keydown(box, 'ArrowLeft');
    keydown(box, 'ArrowLeft');
    keydown(box, 'ArrowRight');
    expect(container.contains(box)).toBe(true);
  });

  it('toolbar phrase insert + dropdown render path works', () => {
    mount('');
    click(findButtonByLabel('Insert phrase'));
    expect(onChange.mock.calls.at(-1)![0]).toMatch(/""/);
  });
});
