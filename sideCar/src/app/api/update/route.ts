import { NextResponse } from 'next/server';
import { performUpdate } from '@/lib/self-update';
import { refreshUpdateSource } from '@/lib/ws-client';

/**
 * GET /api/update — which master supplies updates, and is one available
 * POST /api/update — trigger update + restart
 * The update source is the pinned master, else the first master that serves a release.
 */
export async function GET() {
  const src = await refreshUpdateSource();
  if (!src) return NextResponse.json({ available: false, serverUrl: null, error: 'No master serves sidecar updates' });
  return NextResponse.json(src);
}

export async function POST() {
  const src = await refreshUpdateSource();
  if (!src) return NextResponse.json({ error: 'No master serves sidecar updates' }, { status: 400 });
  if (!src.available) {
    return NextResponse.json({ updated: false, serverUrl: src.serverUrl, message: 'Already on latest version' });
  }

  // performUpdate calls process.exit(0) on success, which kills the process
  // before the response is sent. Schedule it after we return the response.
  setTimeout(() => {
    performUpdate(src.serverUrl).catch(() => {});
  }, 100);

  return NextResponse.json({ updated: true, version: src.version, serverUrl: src.serverUrl, message: 'Restarting...' });
}
