/**
 * Task #55: tokenization tests for the inline operator/paren chip flow in
 * HaystackFilterInput. We test the pure helpers (extractInlineChips,
 * matchingParenIdx) and the round-trip through buildHaystackFilter →
 * parseBooleanQuery to confirm the unified model produces parser-valid output.
 *
 * @jest-environment jsdom
 */

import {
  extractInlineChips,
  matchingParenIdx,
} from '../haystack-filter-input';
import {
  buildHaystackFilter,
  type FilterChip,
} from '@/lib/search/haystack-query-builder';
import { parseBooleanQuery } from '@/lib/search/boolean-query';

describe('extractInlineChips — operator detection on space', () => {
  it('commits lowercase `and ` as an and chip', () => {
    const r = extractInlineChips('and ', 'space');
    expect(r.newChips).toEqual([{ kind: 'and' }]);
    expect(r.remaining).toBe('');
  });

  it('commits `or ` mid-stream and keeps preceding text', () => {
    const r = extractInlineChips('foo or ', 'space');
    expect(r.newChips).toEqual([{ kind: 'or' }]);
    expect(r.remaining).toBe('foo');
  });

  it('does NOT commit `Andersen` mid-word', () => {
    // `Andersen ` does not match the trailing-whole-word operator regex.
    const r = extractInlineChips('Andersen ', 'space');
    expect(r.newChips).toEqual([]);
  });

  it('does NOT commit uppercase `AND ` (post-#55 uppercase is a real error)', () => {
    const r = extractInlineChips('AND ', 'space');
    expect(r.newChips).toEqual([]);
  });

  it('lparen / rparen triggers commit a single paren chip', () => {
    expect(extractInlineChips('foo', 'lparen').newChips).toEqual([{ kind: 'lparen' }]);
    expect(extractInlineChips('foo', 'rparen').newChips).toEqual([{ kind: 'rparen' }]);
  });
});

describe('matchingParenIdx', () => {
  it('finds the rparen matching a leading lparen', () => {
    const chips: FilterChip[] = [
      { kind: 'lparen' },
      { kind: 'term', value: 'a' },
      { kind: 'and' },
      { kind: 'term', value: 'b' },
      { kind: 'rparen' },
    ];
    expect(matchingParenIdx(chips, 0)).toBe(4);
    expect(matchingParenIdx(chips, 4)).toBe(0);
  });

  it('handles nested parens', () => {
    const chips: FilterChip[] = [
      { kind: 'lparen' },
      { kind: 'lparen' },
      { kind: 'term', value: 'a' },
      { kind: 'rparen' },
      { kind: 'rparen' },
    ];
    expect(matchingParenIdx(chips, 0)).toBe(4);
    expect(matchingParenIdx(chips, 1)).toBe(3);
  });
});

describe('buildHaystackFilter — linear serialization with inline chips', () => {
  it('serializes `motion and compel` chip array as a parser-valid string', () => {
    const chips: FilterChip[] = [
      { kind: 'term', value: 'motion' },
      { kind: 'and' },
      { kind: 'term', value: 'compel' },
    ];
    const { filter } = buildHaystackFilter(chips, '');
    expect(filter).toBe('motion and compel');
    // Round-trip: must parse without error.
    const r = parseBooleanQuery(filter);
    expect(r.ok).toBe(true);
  });

  it('serializes parens + or as a parser-valid string', () => {
    const chips: FilterChip[] = [
      { kind: 'lparen' },
      { kind: 'term', value: 'motion' },
      { kind: 'and' },
      { kind: 'term', value: 'compel' },
      { kind: 'rparen' },
      { kind: 'or' },
      { kind: 'term', value: 'appeal' },
    ];
    const { filter } = buildHaystackFilter(chips, '');
    expect(filter).toBe('(motion and compel) or appeal');
    const r = parseBooleanQuery(filter);
    expect(r.ok).toBe(true);
  });

  it('mixes a field chip with an or operator chip', () => {
    const chips: FilterChip[] = [
      { key: 'judge', value: '@person-roberts' },
      { kind: 'or' },
      { kind: 'term', value: 'bias' },
    ];
    const { filter } = buildHaystackFilter(chips, '');
    expect(filter).toBe('judgeRef==@person-roberts or bias');
    expect(parseBooleanQuery(filter).ok).toBe(true);
  });
});

describe('parser uppercase rejection (#55)', () => {
  it('rejects uppercase AND with the lowercase-suggestion error', () => {
    const r = parseBooleanQuery('motion AND compel');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/lowercase `and` \/ `or` \/ `not`/);
    }
  });

  it('still rejects legacy `field:` syntax (#59 preserved)', () => {
    const r = parseBooleanQuery('motionType:disqualify');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Use `==` for equality/);
    }
  });
});
