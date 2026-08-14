/**
 * Backfill `Filing.filingDate` from the haystack `filedOn` tag (task #70).
 *
 * Only the safe half: filings whose entity row already carries a `filedOn`
 * tag. Extracting file-stamp dates from the PDFs for the rest is a separate,
 * much larger job and is deliberately out of scope.
 *
 * Normalisation is `filedOnFromTags` — the SAME function the read-path
 * fallback uses — so a backfilled column can never disagree with what the
 * graph route was already serving from tags.
 *
 * Run:  npx tsx scripts/backfill-filing-date.ts          (dry run, default)
 *       npx tsx scripts/backfill-filing-date.ts --write  (apply)
 *
 * Reverting: restore the pre-run backup, or
 *   UPDATE Filing SET filingDate = NULL WHERE id IN (...);
 * the applied ids are printed (count only here; ids go to the log).
 */
import { prisma } from '../src/lib/db/prisma';
import { filedOnFromTags } from '../src/lib/scope/connectivity';

const WRITE = process.argv.includes('--write');

async function main(): Promise<void> {
  // Entity rows that can carry the tag, keyed by the filing id they adopt.
  const [motions, attachments, reporters, clerks] = await Promise.all([
    prisma.motion.findMany({ select: { id: true, tags: true } }),
    prisma.motionAttachment.findMany({ select: { id: true, tags: true } }),
    prisma.reportersRecord.findMany({ select: { id: true, tags: true } }),
    prisma.clerksRecord.findMany({ select: { id: true, tags: true } }),
  ]);

  // Precedence mirrors the read path: the attachment is the row the tag panel
  // writes for attachment-kind filings, so it wins over the shadow Motion.
  const byFiling = new Map<string, string>();
  const put = (id: string, iso: string | null) => {
    if (iso) byFiling.set(id, iso);
  };
  for (const m of motions) put(m.id, filedOnFromTags(m.tags));
  for (const r of reporters) put(r.id, filedOnFromTags(r.tags));
  for (const c of clerks) put(c.id, filedOnFromTags(c.tags));
  for (const a of attachments) put(a.id, filedOnFromTags(a.tags));

  const filings = await prisma.filing.findMany({ select: { id: true, filingDate: true } });
  const filingIds = new Set(filings.map((f) => f.id));

  const candidates = [...byFiling.entries()].filter(([id]) => filingIds.has(id));
  const alreadySet = filings.filter((f) => f.filingDate != null).length;

  console.log(`filings:                 ${filings.length}`);
  console.log(`  filingDate already set: ${alreadySet}`);
  console.log(`  filedOn tag available:  ${candidates.length}`);
  console.log(`  would populate:         ${candidates.length}`);

  if (!WRITE) {
    console.log('\nDRY RUN — pass --write to apply.');
    return;
  }

  let updated = 0;
  for (const [id, iso] of candidates) {
    await prisma.filing.update({ where: { id }, data: { filingDate: new Date(iso) } });
    updated += 1;
  }
  console.log(`\nWROTE ${updated} rows.`);

  const after = await prisma.filing.count({ where: { filingDate: { not: null } } });
  console.log(`filings with filingDate now: ${after}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
