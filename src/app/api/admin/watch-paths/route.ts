/**
 * Watch Paths API Route
 *
 * GET  /api/admin/watch-paths — list configured watch paths
 * POST /api/admin/watch-paths — add a watch path
 * DELETE /api/admin/watch-paths — remove a watch path
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const dynamic = 'force-dynamic';

const CONFIG_KEY = 'watch.paths';

async function getWatchPaths(): Promise<string[]> {
  const config = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
  if (!config || !config.value) {
    // Fall back to env var
    const envPaths = process.env.WATCH_PATHS;
    return envPaths ? envPaths.split(',').map(p => p.trim()).filter(Boolean) : [];
  }
  try {
    return JSON.parse(config.value) as string[];
  } catch {
    return [];
  }
}

async function saveWatchPaths(paths: string[]): Promise<void> {
  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    update: { value: JSON.stringify(paths) },
    create: { key: CONFIG_KEY, value: JSON.stringify(paths) },
  });
}

export async function GET() {
  try {
    const paths = await getWatchPaths();
    return NextResponse.json({ paths });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get watch paths' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path } = body;

    if (!path || typeof path !== 'string') {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }

    const paths = await getWatchPaths();
    if (paths.includes(path)) {
      return NextResponse.json({ error: 'Path already exists' }, { status: 409 });
    }

    paths.push(path);
    await saveWatchPaths(paths);

    return NextResponse.json({ paths });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add watch path' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { path } = body;

    if (!path || typeof path !== 'string') {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }

    const paths = await getWatchPaths();
    const filtered = paths.filter(p => p !== path);
    if (filtered.length === paths.length) {
      return NextResponse.json({ error: 'Path not found' }, { status: 404 });
    }

    await saveWatchPaths(filtered);

    return NextResponse.json({ paths: filtered });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to remove watch path' },
      { status: 500 }
    );
  }
}
