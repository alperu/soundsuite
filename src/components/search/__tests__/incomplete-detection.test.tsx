/**
 * Tests for isLikelyMidTyping — used to suppress the red boolean-syntax
 * error bar while the user is still composing operators.
 * @jest-environment jsdom
 */

import { isLikelyMidTyping } from '../filter-logic-panel';

describe('isLikelyMidTyping', () => {
  it('suppresses error for trailing operator (motionType:x or )', () => {
    expect(isLikelyMidTyping('motionType:x or ', 16)).toBe(true);
  });

  it('suppresses error for leading or (or foo)', () => {
    expect(isLikelyMidTyping('or foo', 0)).toBe(true);
  });

  it('suppresses error for operator-only input (and)', () => {
    expect(isLikelyMidTyping('and', 0)).toBe(true);
  });

  it('shows red error for mismatched open paren (motion and (compel)', () => {
    expect(isLikelyMidTyping('motion and (compel', 18)).toBe(false);
  });

  it('shows red error for extra close paren ((a and b)))', () => {
    expect(isLikelyMidTyping('(a and b))', 9)).toBe(false);
  });

  it('returns true for empty string (no pill rendered by caller)', () => {
    expect(isLikelyMidTyping('', 0)).toBe(true);
  });

  // Sanity: this string parses cleanly so callers never invoke this helper,
  // but it should not be flagged as mid-typing if it ever does.
  it('does not flag a complete valid query as mid-typing', () => {
    expect(isLikelyMidTyping('appeal', 0)).toBe(false);
  });

  it('suppresses error for trailing not', () => {
    expect(isLikelyMidTyping('motion not ', 11)).toBe(true);
  });

  it('suppresses error for trailing dash operator', () => {
    expect(isLikelyMidTyping('motion -', 8)).toBe(true);
  });

  it('suppresses error for trailing open paren', () => {
    expect(isLikelyMidTyping('motion and (', 12)).toBe(true);
  });

  // Task #59 — legacy `field:` is a real syntax error, not mid-typing.
  it('does not suppress error for legacy `motionType:` (real syntax error)', () => {
    expect(isLikelyMidTyping('motionType:', 10)).toBe(false);
  });

  it('does not suppress error for legacy `motionType:value` (real syntax error)', () => {
    expect(isLikelyMidTyping('motionType:value', 10)).toBe(false);
  });

  // Trailing Axon op without value IS mid-typing (user still typing).
  it('suppresses error for trailing `==` (mid-typing a value)', () => {
    expect(isLikelyMidTyping('case==', 6)).toBe(true);
  });
});
