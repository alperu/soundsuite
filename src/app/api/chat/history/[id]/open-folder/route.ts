import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data', 'chat', 'history');

/**
 * POST /api/chat/history/[id]/open-folder
 * Returns the file path of the chat history markdown file.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const caseNumber = body.caseNumber as string | undefined;

  const subDir = caseNumber
    ? caseNumber.replace(/[^a-zA-Z0-9_-]/g, '_')
    : '_general';
  const filePath = path.join(DATA_DIR, subDir, `${id}.md`);

  if (fs.existsSync(filePath)) {
    return NextResponse.json({ path: filePath });
  }

  // Search all subdirs
  try {
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = path.join(DATA_DIR, entry.name, `${id}.md`);
        if (fs.existsSync(candidate)) {
          return NextResponse.json({ path: candidate });
        }
      }
    }
  } catch {}

  return NextResponse.json({ error: 'File not found' }, { status: 404 });
}
