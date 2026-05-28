/**
 * Unit tests for the deterministic detectors added in #46 / #48.
 *
 * These tests are pure-function tests — no DB, no LanceDB, no AI call.
 * We mock heavy dependencies so the import chain doesn't drag in Prisma's
 * native bindings (which require TextEncoder polyfill before jest.setup).
 */

// Mock prisma before importing extractor (extractor imports prisma at top level)
jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
// Mock AI provider (not needed for deterministic tests)
jest.mock('@/lib/ai/ai-provider', () => ({ completeAI: jest.fn() }));

import {
  detectSignedOnDeterministic,
  detectClerkRefDeterministic,
  type ChunkExcerpt,
} from '../extractor';

// Helper: wrap raw text into a minimal ChunkExcerpt array.
function chunks(text: string): ChunkExcerpt[] {
  return [{ text, pageNumber: 1, chunkIndex: 0 }];
}

// ─── detectSignedOnDeterministic ─────────────────────────────────────────────

describe('detectSignedOnDeterministic', () => {
  it('parses "SIGNED this Nth day of Month, YYYY" → YYYY-MM-DD', () => {
    const result = detectSignedOnDeterministic(
      chunks('SIGNED this 12th day of March, 2026'),
    );
    expect(result).not.toBeNull();
    expect(result!.iso).toBe('2026-03-12');
    expect(result!.confidence).toBe('medium');
  });

  it('parses "SIGNED this 1st day of January, 2025"', () => {
    const result = detectSignedOnDeterministic(
      chunks('SIGNED this 1st day of January, 2025'),
    );
    expect(result).not.toBeNull();
    expect(result!.iso).toBe('2025-01-01');
  });

  it('parses "SIGNED: 3/12/2026"', () => {
    const result = detectSignedOnDeterministic(chunks('SIGNED: 3/12/2026'));
    expect(result).not.toBeNull();
    expect(result!.iso).toBe('2026-03-12');
  });

  it('parses "SIGNED 2026-03-12"', () => {
    const result = detectSignedOnDeterministic(chunks('SIGNED 2026-03-12'));
    expect(result).not.toBeNull();
    expect(result!.iso).toBe('2026-03-12');
  });

  it('returns null when no SIGNED pattern present', () => {
    const result = detectSignedOnDeterministic(
      chunks('This is a general motion with no signature date.'),
    );
    expect(result).toBeNull();
  });

  it('returns null for empty chunks', () => {
    expect(detectSignedOnDeterministic([])).toBeNull();
  });
});

// ─── detectClerkRefDeterministic ─────────────────────────────────────────────

describe('detectClerkRefDeterministic', () => {
  it('detects "Velva L. Price, District Clerk" → name + high confidence', () => {
    const result = detectClerkRefDeterministic(
      chunks('Velva L. Price, District Clerk'),
    );
    expect(result).not.toBeNull();
    expect(result!.name).toMatch(/Velva/);
    expect(result!.confidence).toBe('high');
  });

  it('detects "Anne Lorentzen" known clerk name', () => {
    const result = detectClerkRefDeterministic(
      chunks('Filed by Anne Lorentzen, Travis County District Clerk'),
    );
    expect(result).not.toBeNull();
    expect(result!.name).toMatch(/Anne Lorentzen/i);
    expect(result!.confidence).toBe('high');
  });

  it('detects generic titled clerk "Jane Smith, District Clerk"', () => {
    const result = detectClerkRefDeterministic(
      chunks('Certified correct: Jane Smith, District Clerk'),
    );
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Jane Smith');
    expect(result!.confidence).toBe('medium');
  });

  it('detects "/s/ Jane Smith, Deputy Clerk" (high — actual signer)', () => {
    // Deputy clerk signatures are HIGH confidence because the deputy is the
    // person who actually file-stamped the document, vs. the district clerk
    // whose name appears on every stamp as the office head.
    const result = detectClerkRefDeterministic(
      chunks('/s/ Jane Smith, Deputy Clerk'),
    );
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Jane Smith');
    expect(result!.confidence).toBe('high');
  });

  it('prefers deputy clerk over named district clerk on same stamp', () => {
    // Texas e-filed stamps usually carry BOTH names: "Velva L. Price,
    // District Clerk" (office head) and a deputy who actually stamped.
    // We want the deputy.
    const result = detectClerkRefDeterministic(
      chunks(
        'Velva L. Price, District Clerk\nCassandra Mendieta, Deputy Clerk',
      ),
    );
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Cassandra Mendieta');
    expect(result!.confidence).toBe('high');
  });

  it('returns null when no clerk pattern present', () => {
    const result = detectClerkRefDeterministic(
      chunks('No clerk information here.'),
    );
    expect(result).toBeNull();
  });

  it('returns null for empty chunks', () => {
    expect(detectClerkRefDeterministic([])).toBeNull();
  });
});
