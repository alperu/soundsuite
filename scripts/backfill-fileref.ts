/**
 * scripts/backfill-fileref.ts
 *
 * One-shot repair: enforce the invariant
 *   "every Filing entity row with documentId set has tags.fileRef = {_kind:'ref', val:<documentId>}"
 *
 * Covers the four documentId-bearing entity models:
 *   MotionAttachment, MotionEvent, ClerksRecord, ReportersRecord
 *
 * Skips the Motion model (no documentId column → fileRef N/A).
 * Uses `commitEntity` so the write goes through the same code path as
 * the panel and the tag-fill APPLY route — keeps semantics consistent
 * (ActionLog wiring, XETO validators, etc.).
 *
 * Idempotent: rows already satisfying the invariant produce an equal-shape
 * rewrite which `enforceFileRefSync` normalizes.
 *
 * Usage:
 *   npx tsx scripts/backfill-fileref.ts            # dry run, prints stats
 *   npx tsx scripts/backfill-fileref.ts --apply    # actually commit fixes
 */

import { prisma } from '@/lib/db/prisma';
import { commitEntity } from '@/app/api/haystack/[op]/route';

interface ModelSpec {
  kind: string; // commitEntity kind
  prisma: string; // prisma client property
  display: string;
}

const TARGETS: ModelSpec[] = [
  { kind: 'motionAttachment', prisma: 'motionAttachment', display: 'MotionAttachment' },
  { kind: 'motionEvent', prisma: 'motionEvent', display: 'MotionEvent' },
  { kind: 'clerksRecord', prisma: 'clerksRecord', display: 'ClerksRecord' },
  { kind: 'reportersRecord', prisma: 'reportersRecord', display: 'ReportersRecord' },
];

type Row = { id: string; documentId: string | null; tags: any };

function tagFileRefId(tags: any): string | null {
  if (!tags || typeof tags !== 'object') return null;
  const fr = tags.fileRef;
  if (!fr) return null;
  if (typeof fr === 'string') return fr || null;
  if (typeof fr === 'object') {
    const v = (fr as any).val ?? (fr as any).id;
    return typeof v === 'string' && v ? v : null;
  }
  return null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`[backfill-fileref] mode=${apply ? 'APPLY' : 'dry-run'}`);

  let totalScanned = 0;
  let totalNeedFix = 0;
  let totalFixed = 0;
  let totalFailed = 0;
  let totalAlreadyOk = 0;
  let totalOrphan = 0;

  for (const spec of TARGETS) {
    const client = (prisma as any)[spec.prisma];
    if (!client?.findMany) {
      console.warn(`[backfill-fileref] ${spec.display}: prisma client missing, skipping`);
      continue;
    }

    const rows: Row[] = await client.findMany({
      where: { documentId: { not: null } },
      select: { id: true, documentId: true, tags: true },
    });

    let modelScanned = rows.length;
    let modelNeedFix = 0;
    let modelFixed = 0;
    let modelFailed = 0;
    let modelOk = 0;
    let modelOrphan = 0;

    for (const row of rows) {
      const docId = row.documentId;
      if (!docId) continue;

      // Orphan check — Document row must still exist.
      const doc = await (prisma as any).document.findUnique({
        where: { id: docId },
        select: { id: true },
      });
      if (!doc) {
        modelOrphan++;
        console.warn(
          `[backfill-fileref] ${spec.display} ${row.id}: documentId=${docId} has no Document row (orphan, skipping)`,
        );
        continue;
      }

      const currentTagId = tagFileRefId(row.tags);
      if (currentTagId === docId) {
        modelOk++;
        continue;
      }

      modelNeedFix++;
      if (!apply) continue;

      try {
        const result = await commitEntity({
          id: row.id,
          kind: spec.kind,
          patch: { fileRef: { _kind: 'ref', val: docId } },
        });
        if (result.ok) {
          modelFixed++;
        } else {
          modelFailed++;
          console.warn(
            `[backfill-fileref] ${spec.display} ${row.id}: commit failed → ${result.errGridJson}`,
          );
        }
      } catch (err) {
        modelFailed++;
        console.warn(
          `[backfill-fileref] ${spec.display} ${row.id}: threw → ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log(
      `[backfill-fileref] ${spec.display}: scanned=${modelScanned} alreadyOk=${modelOk} needFix=${modelNeedFix} fixed=${modelFixed} failed=${modelFailed} orphan=${modelOrphan}`,
    );

    totalScanned += modelScanned;
    totalNeedFix += modelNeedFix;
    totalFixed += modelFixed;
    totalFailed += modelFailed;
    totalAlreadyOk += modelOk;
    totalOrphan += modelOrphan;
  }

  console.log(
    `[backfill-fileref] TOTAL scanned=${totalScanned} alreadyOk=${totalAlreadyOk} needFix=${totalNeedFix} fixed=${totalFixed} failed=${totalFailed} orphan=${totalOrphan}`,
  );
  if (!apply && totalNeedFix > 0) {
    console.log(`[backfill-fileref] re-run with --apply to commit ${totalNeedFix} fix(es).`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[backfill-fileref] fatal:', err);
  process.exit(1);
});
