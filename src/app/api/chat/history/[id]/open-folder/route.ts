import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data', 'chat', 'history');

/**
 * POST /api/chat/history/[id]/open-folder
 * Opens the folder containing the chat history markdown file in the OS file explorer.
 * Accepts optional { caseNumber } in body to resolve the correct subdirectory.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const caseNumber = body.caseNumber as string | undefined;

  // Resolve directory
  const subDir = caseNumber
    ? caseNumber.replace(/[^a-zA-Z0-9_-]/g, '_')
    : '_general';
  const dir = path.join(DATA_DIR, subDir);
  const filePath = path.join(dir, `${id}.md`);

  // Try to find the file — it might be in a different case subfolder
  let targetDir = dir;
  if (!fs.existsSync(filePath)) {
    // Search all subdirs for this session ID
    try {
      const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const candidate = path.join(DATA_DIR, entry.name, `${id}.md`);
          if (fs.existsSync(candidate)) {
            targetDir = path.join(DATA_DIR, entry.name);
            break;
          }
        }
      }
    } catch {}
  }

  if (!fs.existsSync(targetDir)) {
    return NextResponse.json({ error: 'Directory not found' }, { status: 404 });
  }

  // Open in OS file explorer
  const platform = process.platform;
  const cmd = platform === 'darwin'
    ? `open "${targetDir}"`
    : platform === 'win32'
      ? `explorer "${targetDir}"`
      : `xdg-open "${targetDir}"`;

  return new Promise<NextResponse>((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        resolve(NextResponse.json({ error: err.message, path: targetDir }, { status: 500 }));
      } else {
        resolve(NextResponse.json({ ok: true, path: targetDir }));
      }
    });
  });
}
