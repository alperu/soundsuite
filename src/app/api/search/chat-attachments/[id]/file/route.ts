import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import { prisma } from '@/lib/db/prisma';
import { chatAttachmentFilePath } from '@/lib/chat/chat-attachment-paths';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = await prisma.chatAttachment.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const filePath = chatAttachmentFilePath(row);

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return NextResponse.json({ error: 'File missing on disk' }, { status: 410 });
  }

  const contentType = row.mimeType || 'application/pdf';

  return new NextResponse(buffer as any, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${row.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}
