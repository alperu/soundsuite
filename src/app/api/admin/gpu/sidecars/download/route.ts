import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { isFollowMode } from '@/lib/db/fleet-source';

const sidecarDir = path.join(process.cwd(), 'public', 'sideCar', 'builds');

/**
 * GET /api/admin/gpu/sidecars/download
 * Serves the latest sidecar tarball for auto-update.
 */
export async function GET() {
  try {
    // Follow mode: sidecarmaster ships the sidecar builds; this master offers none.
    if (await isFollowMode()) {
      return NextResponse.json({ error: 'Sidecar builds are managed by sidecarmaster' }, { status: 404 });
    }
    const manifestPath = path.join(sidecarDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return NextResponse.json({ error: 'No sidecar build available' }, { status: 404 });
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const tarballPath = path.join(sidecarDir, manifest.filename);

    if (!fs.existsSync(tarballPath)) {
      return NextResponse.json({ error: 'Tarball not found' }, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(tarballPath);

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${manifest.filename}"`,
        'Content-Length': String(fileBuffer.length),
        'X-Sidecar-Version': manifest.version,
        'X-Sidecar-SHA256': manifest.sha256,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
