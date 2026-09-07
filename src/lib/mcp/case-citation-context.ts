/**
 * Per-case citation context for the case-scoped retrieval tools.
 *
 * Citation quality used to be tied to the *shape* of the scope argument:
 * `caseId: A` looked up the case's jurisdiction (formatter selection) and its
 * per-filing-type volume counts, while a subset scope left `caseId` undefined
 * and silently fell back to corpus-wide defaults. A parameter that degrades
 * citations is a regression, not a gap (docs/tasks/12 follow-up), so both
 * tools now resolve the same context for **every** case in scope and format
 * each row with its own case's.
 *
 * Cost is three batched queries for the whole scope, whatever its size — one
 * `case.findMany`, one `filing.findMany`, one `document.findMany`. Never one
 * per row, and never one per case.
 */

import type { PrismaClient } from '@prisma/client';
import { getCitationFormatter, type CitationFormatter } from '../citations/citation-formatter';

export interface CaseCitationContext {
  /** Formatter chosen from the case's jurisdiction / state / country. */
  formatter: CitationFormatter;
  /** filingType → distinct volume count, for `CitationInput.totalVolumes`. */
  volumeCountMap: Map<string, number>;
  /** The case's docket number, used when neither the chunk nor the document has one. */
  caseNumber?: string;
}

/** Corpus-wide default, for rows whose case is not in scope (or unscoped calls). */
export function defaultCitationContext(): CaseCitationContext {
  return { formatter: getCitationFormatter(), volumeCountMap: new Map() };
}

/**
 * Build one context per case id. Returns an empty map for an empty scope, so
 * an unscoped call keeps its existing corpus-default behaviour.
 */
export async function buildCaseCitationContexts(
  caseIds: string[],
  database: PrismaClient | undefined,
): Promise<Map<string, CaseCitationContext>> {
  const out = new Map<string, CaseCitationContext>();
  const ids = [...new Set(caseIds.filter(Boolean))];
  if (ids.length === 0 || !database) return out;

  let cases: Array<{ id: string; jurisdiction?: string | null; state?: string | null; country?: string | null; caseNumber?: string | null }> = [];
  try {
    cases = await (database as any).case.findMany({
      where: { id: { in: ids } },
      select: { id: true, jurisdiction: true, state: true, country: true, caseNumber: true },
    });
  } catch {
    // A case row we cannot read is not worth failing a search over; the rows
    // fall back to the corpus default below.
  }

  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const id of ids) {
    const c = byId.get(id);
    out.set(id, {
      formatter: getCitationFormatter({
        jurisdiction: c?.jurisdiction || undefined,
        state: c?.state || undefined,
        country: c?.country || undefined,
      }),
      volumeCountMap: new Map<string, number>(),
      caseNumber: c?.caseNumber || undefined,
    });
  }

  // filingType → distinct volumes, per case. Filings first, then filenames
  // for documents that have no Filing row (…-VOL002.pdf).
  const perCaseTypeVolumes = new Map<string, Map<string, Set<number>>>();
  const add = (caseId: string, type: string | null | undefined, vol: number) => {
    if (!caseId || !type) return;
    if (!perCaseTypeVolumes.has(caseId)) perCaseTypeVolumes.set(caseId, new Map());
    const types = perCaseTypeVolumes.get(caseId)!;
    if (!types.has(type)) types.set(type, new Set());
    types.get(type)!.add(vol);
  };

  try {
    const filings: Array<{ caseId: string; filingType?: string | null; volumeNumber?: number | null }> =
      await (database as any).filing.findMany({
        where: { caseId: { in: ids } },
        select: { caseId: true, filingType: true, volumeNumber: true },
      });
    for (const f of filings) add(f.caseId, f.filingType, f.volumeNumber ?? 1);
  } catch { /* filings may not exist for all cases */ }

  try {
    const docs: Array<{ caseId: string; fileName?: string | null; documentType?: string | null }> =
      await (database as any).document.findMany({
        where: { caseId: { in: ids } },
        select: { caseId: true, fileName: true, documentType: true },
      });
    for (const d of docs) {
      const volMatch = d.fileName?.match(/-VOL(\d+)/i);
      add(d.caseId, d.documentType, volMatch ? parseInt(volMatch[1], 10) : 1);
    }
  } catch { /* ignore */ }

  for (const [caseId, types] of perCaseTypeVolumes) {
    const ctx = out.get(caseId);
    if (!ctx) continue;
    for (const [type, vols] of types) ctx.volumeCountMap.set(type, vols.size);
  }

  return out;
}
