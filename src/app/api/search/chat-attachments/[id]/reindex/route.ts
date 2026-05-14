import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import { prisma } from '@/lib/db/prisma';
import { getChatVectorStore } from '@/lib/chat/chat-vector-store';
import { ingestChatAttachment } from '@/lib/chat/chat-ingest';
import { ingestChatImage } from '@/lib/chat/chat-image-ingest';
import { chatAttachmentFilePath } from '@/lib/chat/chat-attachment-paths';
import { logger } from '@/lib/logger';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = await prisma.chatAttachment.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const filePath = chatAttachmentFilePath(row);
  try {
    await fs.access(filePath);
  } catch {
    return NextResponse.json({ error: 'File missing on disk' }, { status: 410 });
  }

  try {
    const vs = await getChatVectorStore(row.chatId);
    await vs.deleteByDocument(row.id);
  } catch (err) {
    logger.warn('chat-attachment reindex: vector delete failed', {
      attachmentId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await prisma.chatAttachment.update({
    where: { id },
    data: { status: 'QUEUED', error: null, chunkCount: null, pageCount: null },
  });

  const kind = row.kind === 'image' ? 'image' : 'pdf';
  const ingestPromise =
    kind === 'pdf'
      ? ingestChatAttachment({
          attachmentId: row.id,
          chatId: row.chatId,
          filePath,
          fileName: row.fileName,
        })
      : ingestChatImage({
          attachmentId: row.id,
          chatId: row.chatId,
          filePath,
          fileName: row.fileName,
        });

  ingestPromise.catch((err) => {
    logger.error('chat-attachment reindex failed', {
      attachmentId: row.id,
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return NextResponse.json({ ok: true });
}
