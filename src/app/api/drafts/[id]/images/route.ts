import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * POST /api/drafts/[id]/images
 * Upload an image for a draft. Optimizes with sharp and saves to /public/exhibits/{caseId}/.
 * Returns the relative URL for use in TipTap Image nodes.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: draftId } = await params;

    const draft = await prisma.draft.findUnique({
      where: { id: draftId },
      select: { id: true, caseId: true },
    });

    if (!draft) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const caseId = (formData.get('caseId') as string) || draft.caseId;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Optimize with sharp
    const sharp = (await import('sharp')).default;
    let img = sharp(buffer);
    const metadata = await img.metadata();

    // Resize if too large
    if (metadata.width && metadata.width > 2048) {
      img = img.resize({ width: 2048, withoutEnlargement: true });
    }

    const optimized = await img.png({ compressionLevel: 6 }).toBuffer();
    const optimizedMeta = await sharp(optimized).metadata();

    // Save to /public/exhibits/{caseId}/
    const publicDir = path.join(process.cwd(), 'public');
    const exhibitDir = path.join(publicDir, 'exhibits', caseId);
    await fs.mkdir(exhibitDir, { recursive: true });

    const filename = `draft-${draftId}-${Date.now()}.png`;
    const absolutePath = path.join(exhibitDir, filename);
    await fs.writeFile(absolutePath, optimized);

    const relativePath = `/exhibits/${caseId}/${filename}`;

    return NextResponse.json({
      url: relativePath,
      width: optimizedMeta.width || 0,
      height: optimizedMeta.height || 0,
      sizeKB: Math.round(optimized.length / 1024),
    });
  } catch (err: any) {
    console.error('[Draft Image Upload]', err);
    return NextResponse.json(
      { error: err.message || 'Upload failed' },
      { status: 500 }
    );
  }
}
