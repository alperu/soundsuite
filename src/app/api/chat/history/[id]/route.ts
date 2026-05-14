import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadSession, deleteSession } from '@/lib/chat/history-service';
import { dropChatTable } from '@/lib/chat/chat-vector-store';
import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logger';

async function cleanupChatAttachments(chatId: string): Promise<void> {
  try {
    await dropChatTable(chatId);
  } catch (err) {
    logger.warn('chat-delete: dropChatTable failed', {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const dir = path.join(process.cwd(), 'data', 'chat-attachments', chatId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('chat-delete: rm attachments dir failed', {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await prisma.chatAttachment.deleteMany({ where: { chatId } });
  } catch (err) {
    logger.warn('chat-delete: chatAttachment rows delete failed', {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface Params {
  params: Promise<{ id: string }>;
}

/** GET /api/chat/history/:id?caseNumber=... */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const caseNumber = request.nextUrl.searchParams.get('caseNumber') || undefined;
    const session = await loadSession(id, caseNumber);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    console.error('Failed to load chat session:', error);
    return NextResponse.json({ error: 'Failed to load session' }, { status: 500 });
  }
}

/** DELETE /api/chat/history/:id?caseNumber=... */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const caseNumber = request.nextUrl.searchParams.get('caseNumber') || undefined;
    const deleted = await deleteSession(id, caseNumber);
    if (!deleted) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    await cleanupChatAttachments(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete chat session:', error);
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 });
  }
}
