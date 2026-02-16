import { NextResponse } from 'next/server';
import { state } from '@/lib/state';
import { checkForUpdate, performUpdate } from '@/lib/self-update';

/**
 * GET /api/update — check if an update is available
 * POST /api/update — trigger update + restart
 */
export async function GET() {
  if (!state.serverUrl) {
    return NextResponse.json({ error: 'Not connected to server' }, { status: 400 });
  }
  const result = await checkForUpdate(state.serverUrl);
  return NextResponse.json(result);
}

export async function POST() {
  if (!state.serverUrl) {
    return NextResponse.json({ error: 'Not connected to server' }, { status: 400 });
  }
  const { available, version } = await checkForUpdate(state.serverUrl);
  if (!available) {
    return NextResponse.json({ updated: false, message: 'Already on latest version' });
  }

  // performUpdate calls process.exit(0) on success, which kills the process
  // before the response is sent. Schedule it after we return the response.
  setTimeout(() => {
    performUpdate(state.serverUrl!).catch(() => {});
  }, 100);

  return NextResponse.json({ updated: true, version, message: 'Restarting...' });
}
