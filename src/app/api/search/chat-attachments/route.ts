import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { prisma } from '@/lib/db/prisma';
import { ingestChatAttachment } from '@/lib/chat/chat-ingest';
import { logger } from '@/lib/logger';

const ATTACHMENT_ROOT = path.join(process.cwd(), 'data', 'chat-attachments');

export async function GET(request: NextRequest) {
  const chatId = request.nextUrl.searchParams.get('chatId');
  if (!chatId) {
    return NextResponse.json({ error: 'chatId required' }, { status: 400 });
  }
  const rows = await prisma.chatAttachment.findMany({
    where: { chatId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      fileName: true,
      sizeBytes: true,
      pageCount: true,
      chunkCount: true,
      status: true,
      error: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ attachments: rows });
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const chatId = formData.get('chatId') as string | null;
    const file = formData.get('file') as File | null;

    if (!chatId) {
      return NextResponse.json({ error: 'chatId required' }, { status: 400 });
    }
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json({ error: 'Only PDF files are supported' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    const existing = await prisma.chatAttachment.findUnique({
      where: { chatId_hash: { chatId, hash } },
    });
    if (existing) {
      return NextResponse.json({ attachment: existing, duplicate: true });
    }

    const chatDir = path.join(ATTACHMENT_ROOT, chatId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await fs.mkdir(chatDir, { recursive: true });
    const filePath = path.join(chatDir, `${hash}.pdf`);
    await fs.writeFile(filePath, buffer);

    const row = await prisma.chatAttachment.create({
      data: {
        chatId,
        fileName: file.name,
        hash,
        sizeBytes: buffer.length,
        status: 'QUEUED',
      },
    });

    // Fire-and-forget ingestion. Status surfaces via GET.
    ingestChatAttachment({
      attachmentId: row.id,
      chatId,
      filePath,
      fileName: file.name,
    }).catch((err) => {
      logger.error('chat-attachment ingestion failed', {
        attachmentId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return NextResponse.json({ attachment: row });
  } catch (error) {
    logger.error('chat-attachment upload error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    );
  }
}
