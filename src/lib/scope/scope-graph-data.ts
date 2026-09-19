/**
 * The scope graph as data — cases → filings → documents with per-filing
 * connectivity — lifted out of `GET /api/scope/graph` so the Haystack ops
 * (`ssScopeGraph`, `ssWorklist`, `ssReadCase`) and the route share one loader.
 *
 * Read-only. Every connectivity read merges FK columns AND the tags JSON via
 * `@/lib/scope/connectivity` — columns alone miss edges that only the tag
 * panel has written.
 *
 * `caseId` narrows every query to one case. The route omits it (the canvas
 * wants everything); an op that answers for one case passes it so a corpus of
 * hundreds of filings is not loaded to answer about ten.
 */
import type { prisma as PrismaInstance } from '@/lib/db/prisma';
import {
  primaryKindForFiling,
  refsFromAttachment,
  filedOnFromTags,
  refsFromMotion,
  type ScopeRefs,
} from '@/lib/scope/connectivity';

export interface ScopeDocumentData {
  id: string;
  status: string;
}

export interface ScopeFilingData {
  id: string;
  filingType: string;
  label: string;
  /** When it was filed, ISO, or null where the record has no date. */
  filingDate: string | null;
  docCount: number;
  indexedCount: number;
  /** Bare ids per slot; the keys are those of `ScopeRefs`. Typed as a plain
   *  record so the canvas's index-signature `ScopeRefs` accepts it too. */
  refs: Record<string, string | undefined>;
  documents: ScopeDocumentData[];
  /** Entity kinds living at this filing's id. Empty when no entity row exists yet. */
  entityKinds: string[];
  /** The one kind this filing *is*. Always populated. */
  primaryKind: string;
}

export interface ScopeCaseData {
  id: string;
  name: string;
  caseNumber: string | null;
  path: string;
  filings: ScopeFilingData[];
  unfiledDocCount: number;
  unfiledIndexedCount: number;
}

/** The app's (extended) Prisma client. Injectable for tests. */
export type ScopeGraphClient = typeof PrismaInstance;

export interface LoadScopeCasesOptions {
  /** Restrict to one case. Omit for the whole corpus. */
  caseId?: string;
}

export async function loadScopeCases(
  prisma: ScopeGraphClient,
  options: LoadScopeCasesOptions = {},
): Promise<ScopeCaseData[]> {
  const caseWhere = options.caseId ? { id: options.caseId } : {};
  const byCase = options.caseId ? { caseId: options.caseId } : {};

  const [cases, filings, documents, motions, attachments, clerks, reporters] = await Promise.all([
    prisma.case.findMany({
      where: caseWhere,
      select: { id: true, name: true, caseNumber: true, path: true },
      orderBy: { name: 'asc' },
    }),
    prisma.filing.findMany({
      where: byCase,
      select: { id: true, caseId: true, filingType: true, title: true, filingDate: true },
      orderBy: [{ caseId: 'asc' }, { filingDate: 'asc' }],
    }),
    prisma.document.findMany({
      where: byCase,
      select: { id: true, caseId: true, filingId: true, status: true },
    }),
    prisma.motion.findMany({
      where: byCase,
      select: {
        id: true, parentMotionId: true, amendsId: true, supersedesId: true,
        judgeId: true, movantId: true, respondentId: true, tags: true,
      },
    }),
    prisma.motionAttachment.findMany({
      where: byCase,
      select: {
        id: true, motionId: true, amendsId: true, supersedesId: true,
        authoredById: true, attachmentKind: true, tags: true,
      },
    }),
    // Record rows adopt the Filing id too, but carry no ref slots the canvas
    // can draw — ids only, for the kind derivation.
    prisma.clerksRecord.findMany({ where: byCase, select: { id: true } }),
    prisma.reportersRecord.findMany({ where: byCase, select: { id: true } }),
  ]);

  const docsByFiling = new Map<string, ScopeDocumentData[]>();
  const unfiledByCase = new Map<string, { total: number; indexed: number }>();
  for (const doc of documents) {
    if (!doc.filingId) {
      const tally = unfiledByCase.get(doc.caseId) ?? { total: 0, indexed: 0 };
      tally.total += 1;
      if (doc.status === 'INDEXED') tally.indexed += 1;
      unfiledByCase.set(doc.caseId, tally);
      continue;
    }
    const list = docsByFiling.get(doc.filingId) ?? [];
    list.push({ id: doc.id, status: doc.status });
    docsByFiling.set(doc.filingId, list);
  }

  // Entity rows adopt `entity.id === Filing.id`. An attachment-kind filing
  // carries BOTH a MotionAttachment and a shadow Motion at that id; the
  // attachment is the row the tag panel writes, so it wins.
  const refsByFiling = new Map<string, ScopeRefs>();
  for (const motion of motions) refsByFiling.set(motion.id, refsFromMotion(motion));
  for (const attachment of attachments) {
    const own = refsFromAttachment(attachment);
    const shadow = refsByFiling.get(attachment.id);
    refsByFiling.set(attachment.id, shadow ? { ...shadow, ...own } : own);
  }

  // `Filing.filingDate` is null across the corpus, so the date the tag panel
  // recorded is the only one there is. The column stays authoritative where
  // it is populated; the attachment wins over its shadow motion.
  const filedOnByFiling = new Map<string, string>();
  for (const motion of motions) {
    const filedOn = filedOnFromTags(motion.tags);
    if (filedOn) filedOnByFiling.set(motion.id, filedOn);
  }
  for (const attachment of attachments) {
    const filedOn = filedOnFromTags(attachment.tags);
    if (filedOn) filedOnByFiling.set(attachment.id, filedOn);
  }

  const kindsByFiling = new Map<string, string[]>();
  const attachmentKindByFiling = new Map<string, string>();
  const clerksRecordIds = new Set(clerks.map((c) => c.id));
  const reportersRecordIds = new Set(reporters.map((r) => r.id));
  const pushKind = (id: string, kind: string) => {
    const kinds = kindsByFiling.get(id) ?? [];
    kinds.push(kind);
    kindsByFiling.set(id, kinds);
  };
  for (const motion of motions) kindsByFiling.set(motion.id, ['motion']);
  for (const attachment of attachments) {
    if (!attachment.attachmentKind) continue;
    attachmentKindByFiling.set(attachment.id, attachment.attachmentKind);
    pushKind(attachment.id, attachment.attachmentKind);
  }
  for (const id of clerksRecordIds) pushKind(id, 'clerksRecord');
  for (const id of reportersRecordIds) pushKind(id, 'reportersRecord');

  const filingsByCase = new Map<string, ScopeFilingData[]>();
  for (const filing of filings) {
    const docs = docsByFiling.get(filing.id) ?? [];
    const list = filingsByCase.get(filing.caseId) ?? [];
    list.push({
      id: filing.id,
      filingType: filing.filingType,
      label: filing.title,
      filingDate: filing.filingDate
        ? filing.filingDate.toISOString()
        : filedOnByFiling.get(filing.id) ?? null,
      docCount: docs.length,
      indexedCount: docs.filter((d) => d.status === 'INDEXED').length,
      refs: { ...(refsByFiling.get(filing.id) ?? {}) },
      documents: docs,
      entityKinds: kindsByFiling.get(filing.id) ?? [],
      primaryKind: primaryKindForFiling(filing.filingType, {
        attachmentKind: attachmentKindByFiling.get(filing.id),
        hasClerksRecord: clerksRecordIds.has(filing.id),
        hasReportersRecord: reportersRecordIds.has(filing.id),
      }),
    });
    filingsByCase.set(filing.caseId, list);
  }

  return cases.map((c) => {
    const unfiled = unfiledByCase.get(c.id) ?? { total: 0, indexed: 0 };
    return {
      id: c.id,
      name: c.name,
      caseNumber: c.caseNumber ?? null,
      path: c.path,
      filings: filingsByCase.get(c.id) ?? [],
      unfiledDocCount: unfiled.total,
      unfiledIndexedCount: unfiled.indexed,
    };
  });
}
