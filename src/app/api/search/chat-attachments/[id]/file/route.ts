import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import { prisma } from '@/lib/db/prisma';

const ATTACHMENT_ROOT = path.join(process.cwd(), 'data', 'chat-attachments');

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = await prisma.chatAttachment.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const chatDir = path.join(ATTACHMENT_ROOT, row.chatId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const filePath = path.join(chatDir, `${row.hash}.pdf`);

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return NextResponse.json({ error: 'File missing on disk' }, { status: 410 });
  }

  return new NextResponse(buffer as any, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${row.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}
