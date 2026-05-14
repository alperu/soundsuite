import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import { prisma } from '@/lib/db/prisma';
import { getChatVectorStore } from '@/lib/chat/chat-vector-store';
import { logger } from '@/lib/logger';

const ATTACHMENT_ROOT = path.join(process.cwd(), 'data', 'chat-attachments');

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = await prisma.chatAttachment.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const vs = await getChatVectorStore(row.chatId);
    await vs.deleteByDocument(row.id);
  } catch (err) {
    logger.warn('chat-attachment: vector delete failed', {
      attachmentId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const chatDir = path.join(ATTACHMENT_ROOT, row.chatId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const filePath = path.join(chatDir, `${row.hash}.pdf`);
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore missing file
  }

  await prisma.chatAttachment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
