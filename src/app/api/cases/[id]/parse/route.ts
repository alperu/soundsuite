import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getServicesManager } from '@/lib/services-manager';
import { publishDocumentEvent, publishFilingEvent } from '@/lib/sse-events';
import crypto from 'crypto';
import fs from 'fs/promises';

function slugify(filingType: string, title: string): string {
  const raw = `${filingType}-${title}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive a human-readable filing title from a filename.
 * Strips extension, replaces separators with spaces, title-cases.
 */
function deriveFilingTitle(fileName: string): string {
  return fileName
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find or create a Filing record for a document based on its classification.
 * Returns the filing ID.
 */
async function findOrCreateFiling(caseId: string, filingType: string, title: string): Promise<string> {
  const slug = slugify(filingType, title);

  // Try to find existing filing with same slug
  const existing = await (prisma as any).filing.findUnique({
    where: { caseId_slug: { caseId, slug } },
  });
  if (existing) return existing.id;

  // Create new filing
  const filing = await (prisma as any).filing.create({
    data: {
      caseId,
      filingType,
      title,
      slug,
    },
  });
  return filing.id;
}

/**
 * POST /api/cases/[id]/parse - Enqueue selected PDFs for parsing
 * Body: { filePaths: string[] }
 *
 * Auto-classifies each document and creates/assigns a Filing record.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { filePaths, filingId: providedFilingId } = body as {
      filePaths: string[];
      filingId?: string; // When provided, skip auto-classification and use this filing
    };

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return NextResponse.json(
        { error: 'filePaths array is required and must not be empty' },
        { status: 400 }
      );
    }

    const caseRecord = await prisma.case.findUnique({ where: { id } });
    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    const results: Array<{ filePath: string; status: string; documentId?: string; filingId?: string; error?: string }> = [];

    for (const filePath of filePaths) {
      try {
        // Validate file exists and is a PDF
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || !filePath.toLowerCase().endsWith('.pdf')) {
          results.push({ filePath, status: 'skipped', error: 'Not a PDF file' });
          continue;
        }

        // Compute hash
        const fileBuffer = await fs.readFile(filePath);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        // Use provided filing ID or auto-classify from filename
        const fileName = path.basename(filePath);
        const documentType = classifyDocument(fileName) || 'Other';
        const filingTitle = deriveFilingTitle(fileName);
        let filingId: string;

        if (providedFilingId) {
          filingId = providedFilingId;
        } else {
          filingId = await findOrCreateFiling(id, documentType, filingTitle);
        }

        // Check if document already exists (by hash or path) — FileWatcher may
        // have created it with DISCOVERED status.  If so, upgrade to QUEUED.
        const existingDoc = await prisma.document.findUnique({ where: { hash } });
        const existingByPath = !existingDoc
          ? await prisma.document.findUnique({ where: { filePath } })
          : null;
        const existing = existingDoc || existingByPath;

        if (existing && existing.status === 'DISCOVERED') {
          // Upgrade DISCOVERED → QUEUED and assign filing
          const doc = await prisma.document.update({
            where: { id: existing.id },
            data: {
              status: 'QUEUED',
              filingId,
              documentType,
            } as any,
          });
          results.push({ filePath, status: 'QUEUED', documentId: doc.id, filingId });

          // Publish SSE events
          publishDocumentEvent({
            type: 'document_added',
            caseId: id,
            documentId: doc.id,
            fileName,
            filePath,
            status: 'QUEUED',
            filingId,
          }).catch(() => {});

          // Ensure workers are running — they poll for QUEUED documents
          try {
            const { getWorkerManager } = await import('@/services/worker-init');
            await getWorkerManager();
          } catch { /* Non-fatal — workers may start later */ }

          continue;
        }

        if (existing) {
          // Already QUEUED, PROCESSING, INDEXED, or ERROR — skip
          results.push({ filePath, status: existing.status, documentId: existing.id });
          continue;
        }

        // Create new document record as QUEUED, assigned to the filing
        const doc = await prisma.document.create({
          data: {
            caseId: id,
            filingId,
            filePath,
            fileName,
            hash,
            status: 'QUEUED',
            documentType,
          } as any,
        });

        results.push({ filePath, status: 'QUEUED', documentId: doc.id, filingId });

        // Publish SSE events for real-time updates
        publishDocumentEvent({
          type: 'document_added',
          caseId: id,
          documentId: doc.id,
          fileName,
          filePath,
          status: 'QUEUED',
          filingId,
        }).catch(() => {});

        publishFilingEvent({
          type: 'filing_created',
          caseId: id,
          filingId,
          filingType: documentType,
          title: filingTitle,
        }).catch(() => {});

        // Ensure workers are running — they poll for QUEUED documents
        try {
          const { getWorkerManager } = await import('@/services/worker-init');
          await getWorkerManager();
        } catch {
          // Non-fatal — workers may start later
        }
      } catch (err) {
        results.push({
          filePath,
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      caseId: id,
      queued: results.filter(r => r.status === 'QUEUED').length,
      skipped: results.filter(r => r.status !== 'QUEUED').length,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to parse files' },
      { status: 500 }
    );
  }
}

/**
 * Classify a document type from its filename.
 * Returns a filing type string. If no match, returns null (caller uses "Other").
 */
function classifyDocument(fileName: string): string | null {
  const lower = fileName.toLowerCase();

  const types: Array<{ pattern: RegExp; type: string }> = [
    { pattern: /bill\s*of\s*review/i, type: 'Bill of Review' },
    { pattern: /motion/i, type: 'Motion' },
    { pattern: /notice/i, type: 'Notice' },
    { pattern: /letter/i, type: 'Letter' },
    { pattern: /order/i, type: 'Order' },
    { pattern: /petition/i, type: 'Petition' },
    { pattern: /affidavit/i, type: 'Affidavit' },
    { pattern: /subpoena/i, type: 'Subpoena' },
    { pattern: /deposition/i, type: 'Deposition' },
    { pattern: /brief/i, type: 'Brief' },
    { pattern: /complaint/i, type: 'Complaint' },
    { pattern: /response/i, type: 'Response' },
    { pattern: /reply/i, type: 'Reply' },
    { pattern: /exhibit/i, type: 'Exhibit' },
    { pattern: /summons/i, type: 'Summons' },
    { pattern: /judgment|judgement/i, type: 'Judgment' },
    { pattern: /decree/i, type: 'Decree' },
    { pattern: /stipulation/i, type: 'Stipulation' },
    { pattern: /declaration/i, type: 'Declaration' },
    { pattern: /memorandum/i, type: 'Memorandum' },
    { pattern: /transcript/i, type: 'Transcript' },
    { pattern: /citation/i, type: 'Citation' },
    { pattern: /warrant/i, type: 'Warrant' },
    { pattern: /plea/i, type: 'Plea' },
  ];

  for (const { pattern, type } of types) {
    if (pattern.test(lower)) return type;
  }

  return null;
}
