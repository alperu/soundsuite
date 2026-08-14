import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import {
  primaryKindForFiling,
  refsFromAttachment,
  refsFromMotion,
  type ScopeRefs,
} from '@/lib/scope/connectivity';

/**
 * GET /api/scope/graph
 *
 * The whole Haystack scope graph in one payload: cases → filings → documents,
 * with per-filing connectivity refs. At current corpus scale (single-digit
 * cases, low-hundreds of filings, high-hundreds of documents) this is a few
 * hundred KB, so there's no pagination — the block-view canvas wants the whole
 * structure anyway to compute cascade selection.
 *
 * Read-only. Every connectivity read merges FK columns AND the tags JSON via
 * `@/lib/scope/connectivity` — columns alone miss edges that only the tag
 * panel has written.
 */

interface ScopeDocument {
  id: string;
  status: string;
}

interface ScopeFiling {
  id: string;
  filingType: string;
  label: string;
  docCount: number;
  indexedCount: number;
  refs: ScopeRefs;
  documents: ScopeDocument[];
  /** Entity kinds living at this filing's id — `motion` for the Motion row,
   *  the attachment kind when a MotionAttachment shares the id, and
   *  `clerksRecord` / `reportersRecord` for the case-level record rows. A ref
   *  write has to name the row that owns the slot, and `filingType` alone
   *  doesn't say which rows exist. Empty when no entity row exists yet. */
  entityKinds: string[];
  /** The one kind this filing *is* — a Notice is a Notice, not a Motion. Server
   *  -derived so the canvas, the link rules and the tag panel all agree; unlike
   *  `entityKinds` it is always populated, because a filing with no entity row
   *  yet still has a type (the write path materializes the row on first save). */
  primaryKind: string;
}

interface ScopeCase {
  id: string;
  name: string;
  filings: ScopeFiling[];
  /** Documents in the case that hang off no Filing — the large majority today.
   *  They are unreachable through the filing tree but still in scope whenever
   *  the whole case is selected (the `case_id` arm of the scope filter), so the
   *  UI needs the count to keep its "K indexed docs" counter honest. */
  unfiledDocCount: number;
  unfiledIndexedCount: number;
}

export async function GET() {
  try {
    const [cases, filings, documents, motions, attachments, clerks, reporters] = await Promise.all([
      prisma.case.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.filing.findMany({
        select: { id: true, caseId: true, filingType: true, title: true },
        orderBy: [{ caseId: 'asc' }, { filingDate: 'asc' }],
      }),
      prisma.document.findMany({
        select: { id: true, caseId: true, filingId: true, status: true },
      }),
      prisma.motion.findMany({
        select: {
          id: true, parentMotionId: true, amendsId: true, supersedesId: true,
          judgeId: true, movantId: true, respondentId: true, tags: true,
        },
      }),
      prisma.motionAttachment.findMany({
        select: {
          id: true, motionId: true, amendsId: true, supersedesId: true,
          authoredById: true, attachmentKind: true, tags: true,
        },
      }),
      // Record rows adopt the Filing id too, but carry no ref slots the canvas
      // can draw — ids only, for the kind derivation.
      prisma.clerksRecord.findMany({ select: { id: true } }),
      prisma.reportersRecord.findMany({ select: { id: true } }),
    ]);

    const docsByFiling = new Map<string, ScopeDocument[]>();
    const unfiledByCase = new Map<string, { total: number; indexed: number }>();
    // Loose documents stay counters here — `GET /api/scope/unfiled` itemises
    // them, paged, for the editor's panel.
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

    const kindsByFiling = new Map<string, string[]>();
    const attachmentKindByFiling = new Map<string, string>();
    const clerksRecordIds = new Set(clerks.map(c => c.id));
    const reportersRecordIds = new Set(reporters.map(r => r.id));
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
    // Clerk's / Reporter's Record filings own a record row instead of a
    // Motion, so without these two they reported no kinds at all.
    for (const id of clerksRecordIds) pushKind(id, 'clerksRecord');
    for (const id of reportersRecordIds) pushKind(id, 'reportersRecord');

    const filingsByCase = new Map<string, ScopeFiling[]>();
    for (const filing of filings) {
      const docs = docsByFiling.get(filing.id) ?? [];
      const list = filingsByCase.get(filing.caseId) ?? [];
      list.push({
        id: filing.id,
        filingType: filing.filingType,
        label: filing.title,
        docCount: docs.length,
        indexedCount: docs.filter(d => d.status === 'INDEXED').length,
        refs: refsByFiling.get(filing.id) ?? {},
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

    const payload: ScopeCase[] = cases.map(c => {
      const unfiled = unfiledByCase.get(c.id) ?? { total: 0, indexed: 0 };
      return {
        id: c.id,
        name: c.name,
        filings: filingsByCase.get(c.id) ?? [],
        unfiledDocCount: unfiled.total,
        unfiledIndexedCount: unfiled.indexed,
      };
    });

    return NextResponse.json({ cases: payload });
  } catch (err) {
    console.error('[scope/graph] failed', err);
    return NextResponse.json(
      { error: { message: err instanceof Error ? err.message : 'Failed to build scope graph' } },
      { status: 500 },
    );
  }
}
