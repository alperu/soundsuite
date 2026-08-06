import { NextRequest, NextResponse } from 'next/server';
import { setConfigValue, getConfig } from '@/lib/db/config';

export const dynamic = 'force-dynamic';

interface PipelineConfigBody {
  parsingWorkerCount?: number;
  embeddingBatchSize?: number;
  ocrConcurrency?: number;
  ocrTimeoutMs?: number;
  ocrThreshold?: number;
  // Image preprocessing settings
  ocrUpscale?: boolean;
  ocrMinWidth?: number;
  ocrMinDpi?: number;
  ocrGrayscale?: boolean;
  ocrNormalize?: boolean;
  ocrClahe?: boolean;
  ocrClaheClipLimit?: number;
  ocrSharpen?: boolean;
  ocrSharpenSigma?: number;
  ocrResize?: boolean;
  ocrMaxWidth?: number;
  ocrPngCompression?: number;
  docparseEnabled?: boolean;
}

export async function GET() {
  try {
    const config = await getConfig();
    return NextResponse.json(config);
  } catch (error) {
    console.error('Error reading pipeline config:', error);
    return NextResponse.json({ error: 'Failed to read pipeline config' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body: PipelineConfigBody = await request.json();
    const updates: Promise<void>[] = [];

    if (body.parsingWorkerCount !== undefined) {
      const v = Math.max(1, Math.min(5, Math.round(body.parsingWorkerCount)));
      updates.push(setConfigValue('parsing.workerCount', String(v)));
      // The BackgroundScannerDaemon reads this value on its next cycle
      // and adjusts the live worker count — no need to call getWorkerManager()
      // directly (which can trigger full re-initialization in dev mode).
    }

    if (body.embeddingBatchSize !== undefined) {
      const v = Math.max(10, Math.min(200, Math.round(body.embeddingBatchSize)));
      updates.push(setConfigValue('pipeline.embeddingBatchSize', String(v)));
    }

    if (body.ocrConcurrency !== undefined) {
      const v = Math.max(1, Math.min(8, Math.round(body.ocrConcurrency)));
      updates.push(setConfigValue('pipeline.ocrConcurrency', String(v)));
    }

    if (body.ocrTimeoutMs !== undefined) {
      // 10s floor (below that even warm inference fails), 10min ceiling
      const v = Math.max(10_000, Math.min(600_000, Math.round(body.ocrTimeoutMs)));
      updates.push(setConfigValue('pipeline.ocrTimeoutMs', String(v)));
    }

    if (body.ocrThreshold !== undefined) {
      const v = Math.max(10, Math.min(100, Math.round(body.ocrThreshold)));
      updates.push(setConfigValue('pipeline.ocrThreshold', String(v)));
    }

    // Image preprocessing toggles (booleans)
    const booleanKeys: (keyof PipelineConfigBody)[] = [
      'ocrUpscale', 'ocrGrayscale', 'ocrNormalize', 'ocrClahe', 'ocrSharpen', 'ocrResize',
      'docparseEnabled',
    ];
    for (const key of booleanKeys) {
      if (body[key] !== undefined) {
        updates.push(setConfigValue(`pipeline.${key}`, String(body[key])));
      }
    }

    // Image preprocessing numeric values
    if (body.ocrMinWidth !== undefined) {
      const v = Math.max(200, Math.min(4000, Math.round(body.ocrMinWidth)));
      updates.push(setConfigValue('pipeline.ocrMinWidth', String(v)));
    }
    if (body.ocrMinDpi !== undefined) {
      const v = Math.max(50, Math.min(600, Math.round(body.ocrMinDpi)));
      updates.push(setConfigValue('pipeline.ocrMinDpi', String(v)));
    }
    if (body.ocrClaheClipLimit !== undefined) {
      const v = Math.max(1, Math.min(10, Math.round(body.ocrClaheClipLimit)));
      updates.push(setConfigValue('pipeline.ocrClaheClipLimit', String(v)));
    }
    if (body.ocrSharpenSigma !== undefined) {
      const v = Math.max(0.1, Math.min(5, Number(body.ocrSharpenSigma.toFixed(1))));
      updates.push(setConfigValue('pipeline.ocrSharpenSigma', String(v)));
    }
    if (body.ocrMaxWidth !== undefined) {
      const v = Math.max(512, Math.min(8192, Math.round(body.ocrMaxWidth)));
      updates.push(setConfigValue('pipeline.ocrMaxWidth', String(v)));
    }
    if (body.ocrPngCompression !== undefined) {
      const v = Math.max(0, Math.min(9, Math.round(body.ocrPngCompression)));
      updates.push(setConfigValue('pipeline.ocrPngCompression', String(v)));
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No valid fields provided' }, { status: 400 });
    }

    await Promise.all(updates);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error updating pipeline config:', error);
    return NextResponse.json({ error: 'Failed to update pipeline config' }, { status: 500 });
  }
}
