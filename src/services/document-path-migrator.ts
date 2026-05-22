import { prisma } from '@/lib/db/prisma';

interface MigrationResult {
  updated: number;
  skipped: number;
}

/**
 * Rewrite Document.filePath values when a Case.path changes.
 *
 * Finds all Documents for the case whose filePath starts with `oldPath`
 * and replaces that prefix with `newPath`. Idempotent — re-running with
 * the same args is a no-op.
 *
 * Wrap caller in try/catch — failures here must not fail the case commit.
 */
export async function migrateDocumentsForCasePath(
  caseId: string,
  oldPath: string,
  newPath: string,
): Promise<MigrationResult> {
  // Normalize: drop trailing slashes for clean prefix matching. We don't
  // .trim() here because the trailing-whitespace case is exactly the bug
  // we're fixing — the old path may have a space the new path doesn't.
  const oldStripped = oldPath.replace(/\/+$/, '');
  const newStripped = newPath.replace(/\/+$/, '');
  if (!oldStripped || !newStripped || oldStripped === newStripped) {
    return { updated: 0, skipped: 0 };
  }

  const candidates = await prisma.document.findMany({
    where: {
      caseId,
      filePath: { startsWith: oldStripped },
    },
    select: { id: true, filePath: true },
  });

  let updated = 0;
  let skipped = 0;
  for (const doc of candidates) {
    const suffix = doc.filePath.slice(oldStripped.length);
    const newFilePath = newStripped + suffix;
    if (newFilePath === doc.filePath) {
      // Already correct — skip without counting as a failure.
      continue;
    }
    try {
      await prisma.document.update({
        where: { id: doc.id },
        data: { filePath: newFilePath },
      });
      updated++;
    } catch {
      // Most commonly a unique-constraint violation (P2002) — a doc
      // already exists at the new path. Leave the row alone so the
      // operator can resolve manually.
      skipped++;
    }
  }
  return { updated, skipped };
}
