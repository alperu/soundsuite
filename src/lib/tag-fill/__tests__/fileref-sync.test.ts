/**
 * Unit tests for the fileRef ⇔ documentId sync invariant enforced inside
 * `commitEntity`. Pure-function tests — no DB, no Prisma.
 */
import { enforceFileRefSync, FILEREF_MODELS } from '../fileref-sync';

describe('enforceFileRefSync', () => {
  // ─── Models without documentId column → no-op ─────────────────────────────
  it.each(['motion', 'case', 'person', 'court', 'hearing', 'unknownKind'])(
    'is a no-op for non-fileRef model "%s"',
    (model) => {
      const col: Record<string, unknown> = { documentId: 'abc' };
      const tag: Record<string, unknown> = {};
      enforceFileRefSync(model, col, tag);
      expect(col).toEqual({ documentId: 'abc' });
      expect(tag).toEqual({});
    },
  );

  // ─── Column → Tag mirroring ───────────────────────────────────────────────
  it('mirrors documentId column into fileRef tag (canonical ref shape)', () => {
    const col: Record<string, unknown> = { documentId: 'doc-123' };
    const tag: Record<string, unknown> = {};
    enforceFileRefSync('motionAttachment', col, tag);
    expect(tag.fileRef).toEqual({ _kind: 'ref', val: 'doc-123' });
    expect(col.documentId).toBe('doc-123');
  });

  it('clears fileRef tag when documentId column is explicitly null', () => {
    const col: Record<string, unknown> = { documentId: null };
    const tag: Record<string, unknown> = { fileRef: { _kind: 'ref', val: 'stale' } };
    enforceFileRefSync('clerksRecord', col, tag);
    expect(tag.fileRef).toBeNull();
    expect(col.documentId).toBeNull();
  });

  it('overrides a divergent fileRef tag when documentId is set', () => {
    // Caller tried to set a mismatched pair — column wins.
    const col: Record<string, unknown> = { documentId: 'doc-correct' };
    const tag: Record<string, unknown> = {
      fileRef: { _kind: 'ref', val: 'doc-wrong' },
    };
    enforceFileRefSync('reportersRecord', col, tag);
    expect(tag.fileRef).toEqual({ _kind: 'ref', val: 'doc-correct' });
  });

  // ─── Tag → Column mirroring ───────────────────────────────────────────────
  it('mirrors fileRef tag into documentId column when column key absent', () => {
    const col: Record<string, unknown> = {};
    const tag: Record<string, unknown> = {
      fileRef: { _kind: 'ref', val: 'doc-xyz' },
    };
    enforceFileRefSync('motionAttachment', col, tag);
    expect(col.documentId).toBe('doc-xyz');
    expect(tag.fileRef).toEqual({ _kind: 'ref', val: 'doc-xyz' });
  });

  it('normalises bare-string fileRef into canonical ref shape and mirrors', () => {
    const col: Record<string, unknown> = {};
    const tag: Record<string, unknown> = { fileRef: 'doc-bare' };
    enforceFileRefSync('motionEvent', col, tag);
    expect(col.documentId).toBe('doc-bare');
    expect(tag.fileRef).toEqual({ _kind: 'ref', val: 'doc-bare' });
  });

  it('clears documentId when fileRef tag is explicitly null', () => {
    const col: Record<string, unknown> = {};
    const tag: Record<string, unknown> = { fileRef: null };
    enforceFileRefSync('clerksRecord', col, tag);
    expect(col.documentId).toBeNull();
    expect(tag.fileRef).toBeNull();
  });

  // ─── Idempotency ──────────────────────────────────────────────────────────
  it('is idempotent on already-consistent patches', () => {
    const col: Record<string, unknown> = { documentId: 'doc-1' };
    const tag: Record<string, unknown> = {
      fileRef: { _kind: 'ref', val: 'doc-1' },
    };
    enforceFileRefSync('motionAttachment', col, tag);
    enforceFileRefSync('motionAttachment', col, tag);
    expect(col).toEqual({ documentId: 'doc-1' });
    expect(tag).toEqual({ fileRef: { _kind: 'ref', val: 'doc-1' } });
  });

  // ─── No relevant keys → no-op ─────────────────────────────────────────────
  it('does not touch patches without fileRef or documentId keys', () => {
    const col: Record<string, unknown> = { caseId: 'c1' };
    const tag: Record<string, unknown> = { judgeRef: { _kind: 'ref', val: 'p1' } };
    enforceFileRefSync('motionAttachment', col, tag);
    expect(col).toEqual({ caseId: 'c1' });
    expect(tag).toEqual({ judgeRef: { _kind: 'ref', val: 'p1' } });
  });

  // ─── FILEREF_MODELS set sanity ────────────────────────────────────────────
  it('covers the four documentId-bearing Prisma models', () => {
    expect(FILEREF_MODELS.has('motionEvent')).toBe(true);
    expect(FILEREF_MODELS.has('motionAttachment')).toBe(true);
    expect(FILEREF_MODELS.has('clerksRecord')).toBe(true);
    expect(FILEREF_MODELS.has('reportersRecord')).toBe(true);
    expect(FILEREF_MODELS.has('motion')).toBe(false);
  });
});
