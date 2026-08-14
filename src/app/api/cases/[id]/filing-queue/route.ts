/**
 * Background Filing Queue API
 * 
 * POST /api/cases/[id]/filing-queue — Enqueue files for background filing creation
 * GET  /api/cases/[id]/filing-queue — Get current queue status
 * DELETE /api/cases/[id]/filing-queue — Cancel the current queue
 * 
 * Uses Redis to persist queue state so it survives page refreshes.
 */
 

import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getRedis, isRedisAvailable } from '@/lib/redis';
import { FilingsCacheService } from '@/services/filings-cache';

const QUEUE_KEY_PREFIX = 'soundsuite:filing-queue:';
const QUEUE_TTL = 3600; // 1 hour

interface QueueState {
  caseId: string;
  status: 'idle' | 'processing' | 'done' | 'cancelled';
  total: number;
  processed: number;
  created: number;
  failed: number;
  currentFile: string;
  startedAt: number;
  updatedAt: number;
  errors: Array<{ file: string; error: string }>;
}

function queueKey(caseId: string) {
  return `${QUEUE_KEY_PREFIX}${caseId}`;
}

async function getQueueState(caseId: string): Promise<QueueState | null> {
  if (!(await isRedisAvailable())) return null;
  const raw = await getRedis().get(queueKey(caseId));
  return raw ? JSON.parse(raw) : null;
}

async function setQueueState(caseId: string, state: QueueState) {
  if (!(await isRedisAvailable())) return;
  await getRedis().set(queueKey(caseId), JSON.stringify(state), 'EX', QUEUE_TTL);
}


/** GET — return current queue status */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const state = await getQueueState(id);
  if (!state) {
    return NextResponse.json({ status: 'idle', total: 0, processed: 0, created: 0, failed: 0, currentFile: '', errors: [] });
  }
  return NextResponse.json(state);
}

/** DELETE — cancel the current queue */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const state = await getQueueState(id);
  if (state && state.status === 'processing') {
    state.status = 'cancelled';
    state.updatedAt = Date.now();
    await setQueueState(id, state);
  }
  return NextResponse.json({ ok: true });
}

/** POST — enqueue files for background filing creation */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { filePaths } = body;

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return NextResponse.json({ error: 'filePaths required' }, { status: 400 });
  }

  const caseRecord = await prisma.case.findUnique({ where: { id } });
  if (!caseRecord) {
    return NextResponse.json({ error: 'Case not found' }, { status: 404 });
  }

  // Check if already processing
  const existing = await getQueueState(id);
  if (existing?.status === 'processing') {
    return NextResponse.json({ error: 'Queue already processing' }, { status: 409 });
  }

  // Initialize queue state
  const state: QueueState = {
    caseId: id,
    status: 'processing',
    total: filePaths.length,
    processed: 0,
    created: 0,
    failed: 0,
    currentFile: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    errors: [],
  };
  await setQueueState(id, state);

  // Fire and forget — process in background
  processQueue(id, filePaths).catch(() => {});

  return NextResponse.json({ status: 'processing', total: filePaths.length });
}


/** Background processor — runs after response is sent */
async function processQueue(caseId: string, filePaths: string[]) {
  const { detectFiling } = await import('@/services/filing-detector');
  const { getServicesManager } = await import('@/lib/services-manager');
  const crypto = await import('crypto');
  const fs = await import('fs/promises');

  for (let i = 0; i < filePaths.length; i++) {
    // Yield to event loop between files so UI stays responsive
    await new Promise<void>(resolve => setImmediate(resolve));

    // Check for cancellation
    const current = await getQueueState(caseId);
    if (!current || current.status === 'cancelled') break;

    const fp = filePaths[i];
    const fileName = path.basename(fp);

    // Update progress
    current.currentFile = fileName;
    current.updatedAt = Date.now();
    await setQueueState(caseId, current);

    try {
      // Detect filing type
      let filingType = 'Other';
      let title = fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();

      try {
        const detection = await detectFiling(fp);
        if (detection) {
          filingType = detection.filingType;
          title = detection.title;
        }
      } catch { /* use defaults */ }

      // Create filing
      const slug = `${filingType}-${title}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      let filing = await (prisma as any).filing.findUnique({
        where: { caseId_slug: { caseId, slug } },
      });
      if (!filing) {
        filing = await (prisma as any).filing.create({
          data: { caseId, filingType, title, slug },
        });
      }

      // Parse document
      const stat = await fs.stat(fp);
      if (!stat.isFile() || !fp.toLowerCase().endsWith('.pdf')) {
        current.failed++;
        current.errors.push({ file: fileName, error: 'Not a PDF' });
        current.processed = i + 1;
        await setQueueState(caseId, current);
        continue;
      }

      const fileBuffer = await fs.readFile(fp);
      const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      // Check if document already exists (by hash or path) — FileWatcher may
      // have created it with DISCOVERED status
      const existingDoc = await prisma.document.findUnique({ where: { hash } }) as any;
      const existingByPath = !existingDoc
        ? await prisma.document.findUnique({ where: { filePath: fp } }) as any
        : null;
      const existDoc = existingDoc || existingByPath;

      let doc: any;

      if (existDoc && existDoc.status === 'DISCOVERED') {
        // Upgrade DISCOVERED → QUEUED and assign filing
        doc = await prisma.document.update({
          where: { id: existDoc.id },
          data: { status: 'QUEUED', filingId: filing.id, documentType: filingType } as any,
        });
      } else if (existDoc) {
        // Already QUEUED/PROCESSING/INDEXED/ERROR — just assign filing
        await prisma.document.update({ where: { id: existDoc.id }, data: { filingId: filing.id } as any });
        current.created++;
        current.processed = i + 1;
        await setQueueState(caseId, current);
        continue;
      } else {
        // Create new document record as QUEUED
        doc = await prisma.document.create({
          data: {
            caseId,
            filingId: filing.id,
            filePath: fp,
            fileName,
            hash,
            status: 'QUEUED',
            documentType: filingType,
          } as any,
        });
      }

      // Ensure workers are running — they poll for QUEUED documents
      try {
        const { getWorkerManager } = await import('@/services/worker-init');
        await getWorkerManager();
      } catch { /* workers may start later */ }

      current.created++;
    } catch (err) {
      current.failed++;
      current.errors.push({ file: fileName, error: err instanceof Error ? err.message : 'Unknown error' });
    }

    current.processed = i + 1;
    current.updatedAt = Date.now();
    await setQueueState(caseId, current);
  }

  // Mark done
  const final = await getQueueState(caseId);
  if (final && final.status === 'processing') {
    final.status = 'done';
    final.updatedAt = Date.now();
    await setQueueState(caseId, final);
  }

  // Invalidate filings cache after queue completes
  try {
    const filingsCache = new FilingsCacheService();
    await filingsCache.invalidateCase(caseId);
  } catch { /* non-critical */ }

  // Publish event so SSE consumers know filings changed
  try {
    if (await isRedisAvailable()) {
      await getRedis().publish('soundsuite:doc_status', JSON.stringify({
        caseId,
        type: 'filings_changed',
      }));
    }
  } catch { /* non-critical */ }
}
