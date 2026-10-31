import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { isFollowMode } from '@/lib/db/fleet-source';

const manifestPath = path.join(process.cwd(), 'public', 'sideCar', 'builds', 'manifest.json');

/**
 * GET /api/admin/gpu/sidecars/version
 * Returns the latest sidecar version info so sidecars can check for updates.
 */
export async function GET() {
  try {
    // Follow mode: sidecarmaster ships the sidecar builds; this master offers none.
    if (await isFollowMode()) {
      return NextResponse.json({ error: 'Sidecar builds are managed by sidecarmaster' }, { status: 404 });
    }
    if (!fs.existsSync(manifestPath)) {
      return NextResponse.json({ error: 'No sidecar build available' }, { status: 404 });
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return NextResponse.json(manifest);
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
