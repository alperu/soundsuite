/**
 * Active-token picker behaviour for Task #65 (path traversal) and
 * Task #63 (multi-select).
 *
 * The picker UI itself depends on Prisma/network; we exercise the pure
 * helpers (`activeTokenAtCursor`, `forceActiveTokenAtCursor`) and the chip
 * compiler (`termFor` via `buildHaystackFilter`) directly so the tests stay
 * fast and don't require jsdom-fetch wiring.
 *
 * @jest-environment jsdom
 */

import {
  activeTokenAtCursor,
  forceActiveTokenAtCursor,
} from '../active-token-suggestions';
import {
  buildHaystackFilter,
  type FilterChip,
} from '@/lib/search/haystack-query-builder';
import { parseBooleanQuery } from '@/lib/search/boolean-query';

describe('activeTokenAtCursor — path traversal (Task #65)', () => {
  it('returns null for plain freetext', () => {
    expect(activeTokenAtCursor('motion', 6)).toBeNull();
  });

  it('detects a single-segment token with an operator (legacy)', () => {
    const at = activeTokenAtCursor('case==', 6);
    expect(at).not.toBeNull();
    expect(at?.prefix).toBe('case');
    expect(at?.path).toEqual(['case']);
    expect(at?.op).toBe('==');
    expect(at?.partial).toBe('');
  });

  it('detects a 2-hop path: reporterRef->displayName==Smi', () => {
    const text = 'reporterRef->displayName==Smi';
    const at = activeTokenAtCursor(text, text.length);
    expect(at).not.toBeNull();
    expect(at?.prefix).toBe('reporterRef->displayName');
    expect(at?.path).toEqual(['reporterRef', 'displayName']);
    expect(at?.op).toBe('==');
    expect(at?.partial).toBe('Smi');
  });

  it('detects a 2-hop case-attribute: case->jurisdiction==Te', () => {
    const text = 'case->jurisdiction==Te';
    const at = activeTokenAtCursor(text, text.length);
    expect(at).not.toBeNull();
    expect(at?.path).toEqual(['case', 'jurisdiction']);
    expect(at?.partial).toBe('Te');
  });

  it('returns null when the root segment is not a known token', () => {
    const at = activeTokenAtCursor('unknownRoot->field==X', 21);
    expect(at).toBeNull();
  });

  it('forceActiveTokenAtCursor synthesizes empty partial for bare path', () => {
    const text = 'reporterRef->displayName';
    const at = forceActiveTokenAtCursor(text, text.length);
    expect(at).not.toBeNull();
    expect(at?.path).toEqual(['reporterRef', 'displayName']);
    expect(at?.partial).toBe('');
  });
});

describe('chip compilation — path-traversal keys (Task #65)', () => {
  it('compiles a `reporterRef->displayName` chip to canonical Axon', () => {
    const chips: FilterChip[] = [
      { key: 'reporterRef->displayName', value: 'Smith', op: '==' },
    ];
    const { filter } = buildHaystackFilter(chips, '');
    expect(filter).toBe('reporterRef->displayName=="Smith"');
    // Round-trip must parse.
    const r = parseBooleanQuery(filter);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The TERM should carry the full 2-segment path.
      const term = r.ast as { op: string; path?: string[]; value?: string };
      expect(term.op).toBe('TERM');
      expect(term.path).toEqual(['reporterRef', 'displayName']);
      expect(term.value).toBe('Smith');
    }
  });

  it('compiles a `case->jurisdiction` chip and round-trips', () => {
    const chips: FilterChip[] = [
      { key: 'case->jurisdiction', value: 'Texas', op: '==' },
    ];
    const { filter } = buildHaystackFilter(chips, '');
    expect(filter).toBe('case->jurisdiction=="Texas"');
    const r = parseBooleanQuery(filter);
    expect(r.ok).toBe(true);
  });

  it('preserves ref `@uuid` form for path values', () => {
    const chips: FilterChip[] = [
      { key: 'judgeRef->displayName', value: '@uuid-1', op: '==' },
    ];
    const { filter } = buildHaystackFilter(chips, '');
    expect(filter).toBe('judgeRef->displayName==@uuid-1');
  });
});
