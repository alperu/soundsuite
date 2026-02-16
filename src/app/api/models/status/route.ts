/**
 * Model Status API Route
 * 
 * Returns the download status of all models.
 * 
 * Requirements: 18.12
 */

import { NextResponse } from 'next/server';
import { getModelDownloadStatus } from '@/lib/db/config';

/**
 * GET /api/models/status
 * Get download status for all models
 */
export async function GET() {
  try {
    const status = await getModelDownloadStatus();
    return NextResponse.json(status);
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to get model status' },
      { status: 500 }
    );
  }
}
