/** @jest-environment node */
/**
 * Deleting a document must record that it was rejected, or it comes back.
 *
 * The loop this guards, in full: the PDF stays on disk after the row is gone;
 * `POST /api/cases/[id]/rescan` deliberately restarts the FileWatcher so
 * chokidar re-walks every path; `onFileAdded` dedupes only against Document
 * rows by hash and filePath — and this delete removed the one row it could
 * have matched. So the file is recreated as DISCOVERED on the next scan.
 *
 * This was observed live, not theorised: restarting the dev server mid-purge
 * took the unfiled DISCOVERED count from 637 back up to 1,077.
 */

const findUnique = jest.fn();
const del = jest.fn();
const upsert = jest.fn();

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    document: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      delete: (...a: unknown[]) => del(...a),
    },
    ignoredFile: { upsert: (...a: unknown[]) => upsert(...a) },
  },
}));
jest.mock('@/lib/sse-events', () => ({ publishDocumentEvent: jest.fn() }));
jest.mock('@/services/filings-cache', () => ({ FilingsCacheService: class { invalidateCase() { return Promise.resolve(); } } }));
jest.mock('@/lib/vector/vector-store', () => ({
  VectorStore: class {
    async initialize() {}
    async deleteByDocument() {}
  },
}));

import { DELETE } from '../route';

const DOC = {
  id: 'doc-1',
  caseId: 'case-1',
  filePath: '/corpus/alpha/sub/motion.pdf',
  fileName: 'motion.pdf',
  hash: 'sha256-synthetic-0001',
};

function req(url: string) {
  return { nextUrl: new URL(url) } as unknown as Parameters<typeof DELETE>[0];
}
const ctx = { params: Promise.resolve({ id: 'doc-1' }) };

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(DOC);
  del.mockReset().mockResolvedValue({});
  upsert.mockReset().mockResolvedValue({});
});

describe('DELETE /api/documents/[id] — tombstone', () => {
  it('records the file as ignored, keyed by BOTH path and hash', async () => {
    // Path alone resurrects on rename; hash alone resurrects on any re-save.
    // The watcher matches on either, so both must be stored.
    const res = await DELETE(req('http://localhost/api/documents/doc-1'), ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ filePath: DOC.filePath });
    expect(arg.create).toMatchObject({
      filePath: DOC.filePath,
      hash: DOC.hash,
      caseId: DOC.caseId,
      reason: 'deleted',
    });
    expect((await res.json()).ignored).toBe(true);
  });

  it('writes the tombstone BEFORE deleting the row', async () => {
    // If the delete succeeded and the tombstone then failed, the file would be
    // gone from the DB with nothing to stop the watcher re-adding it — the
    // worst of both outcomes.
    const order: string[] = [];
    upsert.mockImplementation(async () => { order.push('tombstone'); });
    del.mockImplementation(async () => { order.push('delete'); });

    await DELETE(req('http://localhost/api/documents/doc-1'), ctx);

    expect(order).toEqual(['tombstone', 'delete']);
  });

  it('upserts rather than inserts, so re-deleting a re-discovered file works', async () => {
    // A file deleted before the tombstone existed can come back and be deleted
    // again; a bare create would throw on the unique filePath.
    const arg = (await DELETE(req('http://localhost/api/documents/doc-1'), ctx), upsert.mock.calls[0][0]) as any;
    expect(arg.update).toMatchObject({ hash: DOC.hash, reason: 'deleted' });
  });

  it('?forget=1 skips the tombstone, for a delete-to-reingest', async () => {
    const res = await DELETE(req('http://localhost/api/documents/doc-1?forget=1'), ctx);

    expect(upsert).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(1);
    expect((await res.json()).ignored).toBe(false);
  });

  it('only the exact opt-out value skips it', async () => {
    for (const v of ['0', 'true', '', 'yes']) {
      upsert.mockClear();
      await DELETE(req(`http://localhost/api/documents/doc-1?forget=${v}`), ctx);
      expect(upsert).toHaveBeenCalledTimes(1);
    }
  });

  it('does not write a tombstone for a document that does not exist', async () => {
    findUnique.mockResolvedValue(null);

    const res = await DELETE(req('http://localhost/api/documents/doc-1'), ctx);

    expect(res.status).toBe(404);
    expect(upsert).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
