/**
 * Model Download API Route
 * 
 * Handles downloading transformers.js models with progress tracking.
 * 
 * Requirements: 18.13, 18.14, 18.15
 */

import { NextRequest, NextResponse } from 'next/server';
import { updateModelDownloadStatus } from '@/lib/db/config';

/**
 * POST /api/models/download
 * Start downloading a model
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
    
    // Check if model is already downloaded
    const isDownloaded = await TransformersEmbeddingProvider.isModelDownloaded(modelName);
    if (isDownloaded) {
      return NextResponse.json(
        { error: 'Model is already downloaded' },
        { status: 400 }
      );
    }
    
    // Update status to downloading
    await updateModelDownloadStatus(modelName, 'transformers', 'downloading', 0);
    
    // Start download in background
    downloadModelInBackground(modelName);
    
    return NextResponse.json({ success: true, message: 'Download started' });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to start download' },
      { status: 500 }
    );
  }
}

/**
 * Download model in background with progress tracking
 */
async function downloadModelInBackground(modelName: string) {
  try {
    // Dynamically import the provider
    const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
    
    // Download the model with progress callback
    await TransformersEmbeddingProvider.downloadModel(
      modelName,
      async (progress, loaded, total) => {
        // Update progress in database
        await updateModelDownloadStatus(
          modelName,
          'transformers',
          'downloading',
          progress,
          BigInt(total)
        );
      }
    );
    
    // Get actual model size after download
    const size = await TransformersEmbeddingProvider.getModelSize(modelName);
    
    // Update status to downloaded
    await updateModelDownloadStatus(
      modelName,
      'transformers',
      'downloaded',
      100,
      BigInt(size)
    );
  } catch (error: any) {
    // Update status to error
    await updateModelDownloadStatus(
      modelName,
      'transformers',
      'error',
      0,
      undefined,
      error.message
    );
  }
}
