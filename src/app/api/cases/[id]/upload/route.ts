import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { publishDocumentEvent } from '@/lib/sse-events';

const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB per file

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

/**
 * POST /api/cases/[id]/upload — multipart upload of PDFs into a case's
 * watched directory. Each uploaded file is written to disk, hashed,
 * deduped, and a Document record is created (assigned to `filingId`
 * if provided) with status QUEUED so the worker picks it up.
 *
 * FormData fields:
 *   - file: File (one or more, repeated `file` entries supported)
 *   - filingId: string (optional)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const caseRecord = await prisma.case.findUnique({ where: { id } });
    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    const form = await request.formData();
    const filingIdRaw = form.get('filingId');
    const filingId = typeof filingIdRaw === 'string' && filingIdRaw.trim() ? filingIdRaw : null;

    if (filingId) {
      const filing = await (prisma as any).filing.findUnique({ where: { id: filingId } });
      if (!filing || filing.caseId !== id) {
        return NextResponse.json({ error: 'filingId does not belong to this case' }, { status: 400 });
      }
    }

    const files = form.getAll('file').filter((v): v is File => v instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const uploadDir = path.join(caseRecord.path, '__uploads');
    await fs.mkdir(uploadDir, { recursive: true });

    const results: Array<{
      fileName: string;
      status: string;
      documentId?: string;
      filingId?: string;
      error?: string;
      /** The hash already existed: this reassigned a document rather than
       *  adding one. Callers report it differently — "queued" would be a lie. */
      duplicate?: boolean;
    }> = [];

    for (const file of files) {
      const originalName = file.name || 'unnamed.pdf';
      try {
        if (!originalName.toLowerCase().endsWith('.pdf')) {
          results.push({ fileName: originalName, status: 'skipped', error: 'Not a PDF' });
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          results.push({ fileName: originalName, status: 'skipped', error: 'File exceeds 200 MB' });
          continue;
        }

        const buf = Buffer.from(await file.arrayBuffer());
        const hash = crypto.createHash('sha256').update(buf).digest('hex');

        // Dedupe: if a document with this hash already exists, reassign filing
        // instead of writing the file again.
        const existing = await prisma.document.findUnique({ where: { hash } });
        if (existing) {
          if (filingId && existing.filingId !== filingId) {
            await prisma.document.update({
              where: { id: existing.id },
              data: { filingId, exhibitLabel: null } as any,
            });
            publishDocumentEvent({
              type: 'document_added',
              caseId: id,
              documentId: existing.id,
              fileName: existing.fileName,
              filePath: existing.filePath,
              status: existing.status,
              filingId,
            }).catch(() => {});
          }
          results.push({
            fileName: originalName,
            status: existing.status,
            documentId: existing.id,
            filingId: filingId || existing.filingId || undefined,
            duplicate: true,
          });
          continue;
        }

        // Pick a non-colliding on-disk name
        const safeName = sanitizeFileName(originalName);
        let destPath = path.join(uploadDir, safeName);
        let counter = 1;
        while (await fileExists(destPath)) {
          const parsed = path.parse(safeName);
          destPath = path.join(uploadDir, `${parsed.name}-${counter}${parsed.ext}`);
          counter++;
        }
        await fs.writeFile(destPath, buf);

        const doc = await prisma.document.create({
          data: {
            caseId: id,
            filingId: filingId || undefined,
            filePath: destPath,
            fileName: path.basename(destPath),
            hash,
            status: 'QUEUED',
            documentType: 'Other',
          } as any,
        });

        publishDocumentEvent({
          type: 'document_added',
          caseId: id,
          documentId: doc.id,
          fileName: doc.fileName,
          filePath: doc.filePath,
          status: 'QUEUED',
          filingId: filingId || undefined,
        }).catch(() => {});

        try {
          const { getWorkerManager } = await import('@/services/worker-init');
          await getWorkerManager();
        } catch { /* workers may start later */ }

        results.push({
          fileName: originalName,
          status: 'QUEUED',
          documentId: doc.id,
          filingId: filingId || undefined,
        });
      } catch (err) {
        results.push({
          fileName: originalName,
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      caseId: id,
      uploaded: results.filter(r => r.status === 'QUEUED').length,
      skipped: results.filter(r => r.status !== 'QUEUED').length,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upload files' },
      { status: 500 }
    );
  }
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}
