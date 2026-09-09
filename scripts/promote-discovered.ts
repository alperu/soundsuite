#!/usr/bin/env npx tsx
/**
 * Bulk-promotion CLI for docs/tasks/35-bulk-promotion.md.
 *
 *   npx tsx scripts/promote-discovered.ts --limit 20
 *   npx tsx scripts/promote-discovered.ts --limit 20 --case <caseId>
 *   npx tsx scripts/promote-discovered.ts --limit 20 --apply
 *   npx tsx scripts/promote-discovered.ts --requeue-errored --limit 5 --apply
 *
 * DRY RUN BY DEFAULT. Nothing is written without `--apply`, and `--limit` is
 * required in both modes, so there is no invocation that promotes the whole
 * backlog — by accident or otherwise.
 *
 * Wave order is read from the database on every run, never from a file. A
 * per-case table written into a task document went stale within hours; the
 * ordering input changes as soon as promotion starts, so re-run this between
 * waves rather than working down a remembered list.
 *
 * Case ids are printed, never case names or paths.
 */

import { PrismaClient } from '@prisma/client';
import {
  planPromotion,
  applyPromotion,
  planRequeueErrored,
  applyRequeue,
} from '../src/lib/ingestion/promotion';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const rawLimit = arg('limit');
  if (!rawLimit) {
    console.error('--limit <n> is required (there is deliberately no default).');
    process.exit(2);
  }
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error(`--limit must be a positive integer, got "${rawLimit}".`);
    process.exit(2);
  }

  const apply = has('apply');
  const caseId = arg('case');
  const prisma = new PrismaClient();

  try {
    if (has('requeue-errored')) {
      const plan = await planRequeueErrored(prisma, { limit, caseId });
      console.log(`measured at      ${plan.measuredAt.toISOString()}`);
      console.log(`ERROR in scope   ${plan.erroredTotal}`);
      console.log(`would requeue    ${plan.documentIds.length} (limit ${plan.limit})`);
      if (!apply) {
        console.log('\nDRY RUN — nothing written. Re-run with --apply to requeue.');
        return;
      }
      const res = await applyRequeue(prisma, plan);
      console.log(`\nrequeued ${res.promoted}; skipped ${res.skipped.length} (no longer ERROR)`);
      return;
    }

    const plan = await planPromotion(prisma, { limit, caseId });

    console.log(`measured at ${plan.measuredAt.toISOString()}`);
    console.log('\nwave order (ascending DISCOVERED, live):');
    for (const w of plan.waveOrder) {
      const mark = w.caseId === plan.caseId ? '→' : ' ';
      console.log(`  ${mark} ${w.caseId}  ${w.discovered}`);
    }

    if (!plan.caseId || plan.documentIds.length === 0) {
      console.log('\nNothing to promote in scope.');
      return;
    }

    console.log(`\ntarget case      ${plan.caseId}`);
    console.log(`would promote    ${plan.documentIds.length} (limit ${plan.limit})`);
    console.log(`left after       ${plan.remainingInCase} DISCOVERED in this case`);
    console.log('mode             unfiled (status only; filingId untouched)');

    if (!apply) {
      console.log('\nDRY RUN — nothing written. Re-run with --apply to promote.');
      return;
    }

    const res = await applyPromotion(prisma, plan);
    console.log(`\npromoted ${res.promoted}; skipped ${res.skipped.length} (no longer DISCOVERED)`);
    console.log('Re-measure before the next wave — promoting changed the ordering input.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
