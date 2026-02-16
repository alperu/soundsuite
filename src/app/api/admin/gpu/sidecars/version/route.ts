import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const manifestPath = path.join(process.cwd(), 'public', 'sideCar', 'builds', 'manifest.json');

/**
 * GET /api/admin/gpu/sidecars/version
 * Returns the latest sidecar version info so sidecars can check for updates.
 */
export async function GET() {
  try {
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
