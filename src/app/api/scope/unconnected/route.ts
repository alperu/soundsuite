import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import {
  attachmentIsUnconnected,
  missingForAttachment,
  missingForMotion,
  motionIsUnconnected,
} from '@/lib/scope/connectivity';

/**
 * GET /api/scope/unconnected
 *
 * The Editor tab's worklist: every entity row that carries no connectivity at
 * all, badged with what it's missing. "Unconnected" is the tag-aware
 * definition — a row counts as connected if an edge lives in EITHER a Prisma
 * FK column or the tags JSON (see `@/lib/scope/connectivity`).
 *
 * Attachment-kind filings own two rows (a MotionAttachment plus the shadow
 * Motion that satisfies its FK). Both are emitted when both are unconnected;
 * they share a `filingId`, so the UI can group them under one filing.
 *
 * Read-only.
 */

interface UnconnectedRow {
  /** Tag-panel entity kind: 'motion', or the attachment kind ('notice', …). */
  entityKind: string;
  /** Which table the row lives in — disambiguates the two rows per filing. */
  entityTable: 'Motion' | 'MotionAttachment';
  entityId: string;
  /** Entity rows adopt `entity.id === Filing.id`; null if the Filing is gone. */
  filingId: string | null;
  caseId: string | null;
  label: string;
  missing: string[];
}

export async function GET() {
  try {
    const [motions, attachments, filings] = await Promise.all([
      prisma.motion.findMany({
        select: {
          id: true, filingId: true, caseId: true, title: true,
          parentMotionId: true, amendsId: true, supersedesId: true,
          judgeId: true, movantId: true, respondentId: true, tags: true,
        },
      }),
      prisma.motionAttachment.findMany({
        select: {
          id: true, motionId: true, caseId: true, attachmentKind: true,
          amendsId: true, supersedesId: true, authoredById: true, tags: true,
        },
      }),
      prisma.filing.findMany({ select: { id: true, title: true } }),
    ]);

    const filingTitleById = new Map(filings.map(f => [f.id, f.title]));
    const rows: UnconnectedRow[] = [];

    for (const motion of motions) {
      if (!motionIsUnconnected(motion)) continue;
      rows.push({
        entityKind: 'motion',
        entityTable: 'Motion',
        entityId: motion.id,
        filingId: filingTitleById.has(motion.id) ? motion.id : motion.filingId ?? null,
        caseId: motion.caseId ?? null,
        label: filingTitleById.get(motion.id) ?? motion.title ?? motion.id,
        missing: missingForMotion(motion),
      });
    }

    for (const attachment of attachments) {
      if (!attachmentIsUnconnected(attachment)) continue;
      rows.push({
        entityKind: attachment.attachmentKind,
        entityTable: 'MotionAttachment',
        entityId: attachment.id,
        filingId: filingTitleById.has(attachment.id) ? attachment.id : null,
        caseId: attachment.caseId,
        label: filingTitleById.get(attachment.id) ?? attachment.attachmentKind,
        missing: missingForAttachment(attachment),
      });
    }

    return NextResponse.json({
      rows,
      counts: {
        total: rows.length,
        motions: rows.filter(r => r.entityTable === 'Motion').length,
        attachments: rows.filter(r => r.entityTable === 'MotionAttachment').length,
      },
    });
  } catch (err) {
    console.error('[scope/unconnected] failed', err);
    return NextResponse.json(
      { error: { message: err instanceof Error ? err.message : 'Failed to build worklist' } },
      { status: 500 },
    );
  }
}
