/**
 * Unit tests for the fileRef ⇔ documentId sync invariant enforced inside
 * `commitEntity`. Pure-function tests — no DB, no Prisma.
 */
import {
  buildFileRefLinkPatch,
  enforceFileRefSync,
  FILEREF_MODELS,
  pickPrimaryDocument,
} from '../fileref-sync';

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

  // ─── Pass 2 backfill helpers ──────────────────────────────────────────────
  describe('pickPrimaryDocument (pass-2 backfill ordering)', () => {
    const d = (
      id: string,
      pageCount: number | null,
      updatedAt: string,
      createdAt = updatedAt,
    ) => ({ id, pageCount, updatedAt: new Date(updatedAt), createdAt: new Date(createdAt) });

    it('returns null for empty candidate list', () => {
      expect(pickPrimaryDocument([])).toBeNull();
    });

    it('prefers the candidate with the highest pageCount', () => {
      const result = pickPrimaryDocument([
        d('small', 5, '2026-05-01T00:00:00Z'),
        d('big', 100, '2026-01-01T00:00:00Z'),
        d('mid', 30, '2026-06-01T00:00:00Z'),
      ]);
      expect(result?.id).toBe('big');
    });

    it('treats null pageCount as lowest priority', () => {
      const result = pickPrimaryDocument([
        d('nullpc', null, '2026-06-01T00:00:00Z'),
        d('hasone', 1, '2026-01-01T00:00:00Z'),
      ]);
      expect(result?.id).toBe('hasone');
    });

    it('tie-breaks pageCount by most-recent updatedAt', () => {
      const result = pickPrimaryDocument([
        d('older', 10, '2026-01-01T00:00:00Z'),
        d('newer', 10, '2026-06-01T00:00:00Z'),
      ]);
      expect(result?.id).toBe('newer');
    });

    it('tie-breaks updatedAt by most-recent createdAt', () => {
      const result = pickPrimaryDocument([
        d('a', 10, '2026-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
        d('b', 10, '2026-01-01T00:00:00Z', '2025-06-01T00:00:00Z'),
      ]);
      expect(result?.id).toBe('b');
    });
  });

  describe('buildFileRefLinkPatch (pass-2 backfill patch shape)', () => {
    it('returns null when there is no candidate Document', () => {
      expect(buildFileRefLinkPatch([])).toBeNull();
    });

    it('builds a fileRef-only patch (column mirroring happens in commitEntity)', () => {
      // Scenario: entity row has documentId=null, Document linked via
      // Document.filingId. Backfill builds this patch; enforceFileRefSync
      // (inside commitEntity) then mirrors fileRef → documentId.
      const patch = buildFileRefLinkPatch([
        {
          id: 'doc-primary',
          pageCount: 73,
          updatedAt: new Date('2026-05-27T00:00:00Z'),
          createdAt: new Date('2026-05-22T00:00:00Z'),
        },
      ]);
      expect(patch).toEqual({ fileRef: { _kind: 'ref', val: 'doc-primary' } });
    });

    it('end-to-end: pass-2 patch fed through enforceFileRefSync populates BOTH documentId and fileRef', () => {
      // Simulates the commitEntity flow for an unlinked ReportersRecord row.
      const patch = buildFileRefLinkPatch([
        {
          id: 'doc-xyz',
          pageCount: 50,
          updatedAt: new Date('2026-05-01T00:00:00Z'),
          createdAt: new Date('2026-05-01T00:00:00Z'),
        },
      ]);
      expect(patch).not.toBeNull();
      // commitEntity splits the patch — fileRef is a tag, documentId is a column.
      const columnPatch: Record<string, unknown> = {};
      const tagPatch: Record<string, unknown> = { ...(patch as object) };
      enforceFileRefSync('reportersRecord', columnPatch, tagPatch);
      expect(columnPatch.documentId).toBe('doc-xyz');
      expect(tagPatch.fileRef).toEqual({ _kind: 'ref', val: 'doc-xyz' });
    });
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
