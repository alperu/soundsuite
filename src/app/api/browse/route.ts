/**
 * GET /api/browse?path=...
 *
 * List subdirectories of a given path for the folder picker.
 * Returns only directories (no files) for navigation.
 * Defaults to user's home directory if no path provided.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export async function GET(request: NextRequest) {
  try {
    const dirPath = request.nextUrl.searchParams.get('path') || os.homedir();
    const resolved = path.resolve(dirPath);

    // Verify it exists and is a directory
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: 'Not a directory' }, { status: 400 });
    }

    const items = await fs.readdir(resolved, { withFileTypes: true });
    const folders: Array<{ name: string; path: string }> = [];

    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory()) {
        folders.push({ name: item.name, path: path.join(resolved, item.name) });
      }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      current: resolved,
      parent: path.dirname(resolved) !== resolved ? path.dirname(resolved) : null,
      folders,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Browse failed' },
      { status: 500 }
    );
  }
}
