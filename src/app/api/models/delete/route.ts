/**
 * Model Delete API Route
 * 
 * Handles deleting downloaded transformers.js models to free disk space.
 * 
 * Requirements: 18.16
 */

import { NextRequest, NextResponse } from 'next/server';
import { updateModelDownloadStatus } from '@/lib/db/config';

/**
 * POST /api/models/delete
 * Delete a downloaded model
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { modelName } = body;
    
    if (!modelName) {
      return NextResponse.json(
        { error: 'modelName is required' },
        { status: 400 }
      );
    }
    
    // Dynamically import the provider to avoid bundling native modules
    const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
    
    // Delete the model
    await TransformersEmbeddingProvider.deleteModel(modelName);
    
    // Update status to not_downloaded
    await updateModelDownloadStatus(
      modelName,
      'transformers',
      'not_downloaded',
      0
    );
    
    return NextResponse.json({ success: true, message: 'Model deleted successfully' });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to delete model' },
      { status: 500 }
    );
  }
}
