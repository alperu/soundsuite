import { MOTION_TYPES, type MotionTypeCategory } from '../motion-types';

const CANONICAL_CATEGORIES: readonly MotionTypeCategory[] = [
  'disposition',
  'discovery',
  'scheduling',
  'procedural',
  'appellate',
  'family-law',
  'evidence',
  'protective',
  'other',
];

const CANONICAL_SOURCES = ['user-data', 'texas-rules', 'frcp', 'practice'] as const;

describe('MOTION_TYPES catalogue', () => {
  it('has at least 80 entries', () => {
    expect(MOTION_TYPES.length).toBeGreaterThanOrEqual(80);
  });

  it('has unique slugs', () => {
    const slugs = MOTION_TYPES.map((m) => m.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('uses valid camelCase slugs', () => {
    const camel = /^[a-z][a-zA-Z0-9]*$/;
    for (const entry of MOTION_TYPES) {
      expect(entry.slug).toMatch(camel);
    }
  });

  it('uses only canonical categories', () => {
    for (const entry of MOTION_TYPES) {
      expect(CANONICAL_CATEGORIES).toContain(entry.category);
    }
  });

  it('uses only canonical sources', () => {
    for (const entry of MOTION_TYPES) {
      expect(CANONICAL_SOURCES).toContain(entry.source);
    }
  });

  it('every entry has a non-empty displayName and shortDoc', () => {
    for (const entry of MOTION_TYPES) {
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(entry.shortDoc.length).toBeGreaterThan(0);
    }
  });

  it('is sorted alphabetically by displayName', () => {
    const names = MOTION_TYPES.map((m) => m.displayName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('aliases (when present) are non-empty arrays of non-empty strings', () => {
    for (const entry of MOTION_TYPES) {
      if (entry.aliases !== undefined) {
        expect(Array.isArray(entry.aliases)).toBe(true);
        expect(entry.aliases.length).toBeGreaterThan(0);
        for (const a of entry.aliases) {
          expect(typeof a).toBe('string');
          expect(a.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('includes an "other" catch-all entry', () => {
    const other = MOTION_TYPES.find((m) => m.slug === 'other');
    expect(other).toBeDefined();
    expect(other?.category).toBe('other');
  });
});
