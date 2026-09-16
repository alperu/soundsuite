/** @jest-environment node */
/**
 * Old chats must self-heal on attach.
 *
 * Chat tables are created on first insert at whatever width the embedding
 * provider produced that day. After the corpus moved from qwen3-embedding:0.6b
 * (1024) to 4b (2560), 32 chat tables stayed at 1024: searching them against
 * a 2560 query hits the dimension guard, and attaching a new file to one of
 * those chats failed at insert. The guard drops a stale table before the
 * insert that recreates it, then the chat's earlier attachments are re-embedded
 * from the files still on disk.
 */

// ── @lancedb/lancedb double ─────────────────────────────────────────────────
const lance = {
  tables: new Map<string, number | null>(), // name -> vector width (null = empty)
  dropped: [] as string[],
};
jest.mock('@lancedb/lancedb', () => ({
  connect: async () => ({
    tableNames: async () => [...lance.tables.keys()],
    dropTable: async (name: string) => { lance.dropped.push(name); lance.tables.delete(name); },
    openTable: async (name: string) => ({
      query: () => ({
        select: () => ({
          limit: () => ({
            toArray: async () => {
              const w = lance.tables.get(name);
              return w ? [{ vector: new Array(w).fill(0) }] : [];
            },
          }),
        }),
      }),
    }),
  }),
}));

// ── prisma / fs / ingest doubles for reingest ───────────────────────────────
const findMany = jest.fn();
const update = jest.fn();
jest.mock('@/lib/db/prisma', () => ({ prisma: { chatAttachment: { findMany: (...a: unknown[]) => findMany(...a), update: (...a: unknown[]) => update(...a) } } }));
jest.mock('../../db/prisma', () => ({ prisma: { chatAttachment: { findMany: (...a: unknown[]) => findMany(...a), update: (...a: unknown[]) => update(...a) } } }));
jest.mock('../../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const present = new Set<string>();
jest.mock('fs/promises', () => ({
  access: async (p: string) => { if (!present.has(p)) throw new Error('ENOENT'); },
}));

const ingestPdf = jest.fn();
const ingestImage = jest.fn();
jest.mock('../chat-ingest', () => ({ ingestChatAttachment: (...a: unknown[]) => ingestPdf(...a) }));
jest.mock('../chat-image-ingest', () => ({ ingestChatImage: (...a: unknown[]) => ingestImage(...a) }));

import { ensureChatTableWidth, getChatTableVectorWidth, chatTableName } from '../chat-vector-store';
import { reingestOtherAttachments, attachmentFilePath } from '../chat-reingest';

const CHAT = 'session-0000000000000';
const TABLE = chatTableName(CHAT);

beforeEach(() => {
  lance.tables.clear();
  lance.dropped.length = 0;
  present.clear();
  findMany.mockReset().mockResolvedValue([]);
  update.mockReset().mockResolvedValue({});
  ingestPdf.mockReset().mockResolvedValue({ pageCount: 1, chunkCount: 3, ocrPages: 0 });
  ingestImage.mockReset().mockResolvedValue({ chunkCount: 1, ocrTextLength: 10 });
});

describe('ensureChatTableWidth', () => {
  it('drops a table whose width differs from the incoming vectors — the 1024 → 2560 case', async () => {
    lance.tables.set(TABLE, 1024);

    const r = await ensureChatTableWidth(CHAT, 2560);

    expect(r).toEqual({ recreated: true, previousWidth: 1024 });
    expect(lance.dropped).toEqual([TABLE]);
  });

  it('leaves a matching table alone', async () => {
    lance.tables.set(TABLE, 2560);

    expect(await ensureChatTableWidth(CHAT, 2560)).toEqual({ recreated: false });
    expect(lance.dropped).toEqual([]);
  });

  it('does nothing when the table does not exist or is empty', async () => {
    expect(await ensureChatTableWidth(CHAT, 2560)).toEqual({ recreated: false });
    lance.tables.set(TABLE, null);
    expect(await ensureChatTableWidth(CHAT, 2560)).toEqual({ recreated: false });
    expect(lance.dropped).toEqual([]);
  });

  it('only ever touches the chat’s own table', async () => {
    lance.tables.set('chunks', 1024); // the main corpus
    lance.tables.set(TABLE, 1024);

    await ensureChatTableWidth(CHAT, 2560);

    expect(lance.dropped).toEqual([TABLE]);
    expect(lance.tables.has('chunks')).toBe(true);
  });

  it('reports the width it found', async () => {
    lance.tables.set(TABLE, 1024);
    expect(await getChatTableVectorWidth(CHAT)).toBe(1024);
    expect(await getChatTableVectorWidth('session-does-not-exist')).toBeNull();
  });
});

describe('attachmentFilePath', () => {
  it('rebuilds the path the upload route wrote: <chatDir>/<hash>.<ext>', () => {
    const p = attachmentFilePath(CHAT, 'abc123', 'application/pdf');
    expect(p.endsWith(`/chat-attachments/${CHAT}/abc123.pdf`)).toBe(true);
    expect(attachmentFilePath(CHAT, 'img1', 'image/png').endsWith('/img1.png')).toBe(true);
  });
});

describe('reingestOtherAttachments', () => {
  const rows = [
    { id: 'a1', fileName: 'one.pdf', hash: 'h1', mimeType: 'application/pdf', kind: 'pdf' },
    { id: 'a2', fileName: 'two.png', hash: 'h2', mimeType: 'image/png', kind: 'image' },
    { id: 'a3', fileName: 'gone.pdf', hash: 'h3', mimeType: 'application/pdf', kind: 'pdf' },
  ];

  it('re-embeds every other INDEXED attachment by kind, and excludes the trigger', async () => {
    findMany.mockResolvedValue(rows.slice(0, 2));
    present.add(attachmentFilePath(CHAT, 'h1', 'application/pdf'));
    present.add(attachmentFilePath(CHAT, 'h2', 'image/png'));

    const s = await reingestOtherAttachments(CHAT, 'trigger');

    expect(findMany.mock.calls[0][0].where).toEqual({ chatId: CHAT, id: { not: 'trigger' }, status: 'INDEXED' });
    expect(ingestPdf).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'a1', chatId: CHAT, fileName: 'one.pdf' }));
    expect(ingestImage).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'a2', chatId: CHAT, fileName: 'two.png' }));
    expect(s).toEqual({ attempted: 2, reindexed: 2, failed: 0, missingFiles: 0 });
  });

  it('marks an attachment whose file is gone as ERROR instead of throwing', async () => {
    findMany.mockResolvedValue([rows[2]]);

    const s = await reingestOtherAttachments(CHAT, 'trigger');

    expect(ingestPdf).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a3' },
      data: expect.objectContaining({ status: 'ERROR' }),
    }));
    expect(s).toEqual({ attempted: 1, reindexed: 0, failed: 0, missingFiles: 1 });
  });

  it('keeps going when one re-index fails — the triggering attach already succeeded', async () => {
    findMany.mockResolvedValue(rows.slice(0, 2));
    present.add(attachmentFilePath(CHAT, 'h1', 'application/pdf'));
    present.add(attachmentFilePath(CHAT, 'h2', 'image/png'));
    ingestPdf.mockRejectedValue(new Error('embed failed'));

    const s = await reingestOtherAttachments(CHAT, 'trigger');

    expect(ingestImage).toHaveBeenCalledTimes(1);
    expect(s).toEqual({ attempted: 2, reindexed: 1, failed: 1, missingFiles: 0 });
  });
});
