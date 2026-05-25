/**
 * Tests for isLikelyMidTyping — used to suppress the red boolean-syntax
 * error bar while the user is still composing operators.
 * @jest-environment jsdom
 */

import { isLikelyMidTyping } from '../filter-logic-panel';

describe('isLikelyMidTyping', () => {
  it('suppresses error for trailing operator (motionType:x OR )', () => {
    expect(isLikelyMidTyping('motionType:x OR ', 16)).toBe(true);
  });

  it('suppresses error for leading OR (OR foo)', () => {
    expect(isLikelyMidTyping('OR foo', 0)).toBe(true);
  });

  it('suppresses error for operator-only input (AND)', () => {
    expect(isLikelyMidTyping('AND', 0)).toBe(true);
  });

  it('shows red error for mismatched open paren (motion AND (compel)', () => {
    expect(isLikelyMidTyping('motion AND (compel', 18)).toBe(false);
  });

  it('shows red error for extra close paren ((a AND b)))', () => {
    expect(isLikelyMidTyping('(a AND b))', 9)).toBe(false);
  });

  it('returns true for empty string (no pill rendered by caller)', () => {
    expect(isLikelyMidTyping('', 0)).toBe(true);
  });

  // Sanity: this string parses cleanly so callers never invoke this helper,
  // but it should not be flagged as mid-typing if it ever does.
  it('does not flag a complete valid query as mid-typing', () => {
    expect(isLikelyMidTyping('appeal', 0)).toBe(false);
  });

  it('suppresses error for trailing NOT', () => {
    expect(isLikelyMidTyping('motion NOT ', 11)).toBe(true);
  });

  it('suppresses error for trailing dash operator', () => {
    expect(isLikelyMidTyping('motion -', 8)).toBe(true);
  });

  it('suppresses error for trailing open paren', () => {
    expect(isLikelyMidTyping('motion AND (', 12)).toBe(true);
  });
});
