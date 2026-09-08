/**
 * @jest-environment node
 *
 * corpus_status — the denominator under every proven-absence claim
 * (docs/tasks/23-corpus-status-and-denominators.md, REPORT-v12 §2a).
 *
 * The assertions here encode the three decisions that make the tool honest
 * rather than merely present:
 *
 *   1. Status buckets come from what `groupBy` observed, never from an assumed
 *      list. The live corpus uses `DISCOVERED`, which is absent from the four
 *      conventional values — a tool built against that list would bucket every
 *      un-ingested document as nothing at all.
 *   2. The two ingest timestamps stay separate. They diverge in production
 *      (measured 9 days apart), so merging them would over-report.
 *   3. An unreadable vector table yields `null` plus a reason, never `0`. A
 *      zero denominator is worse than an absent one: a caller divides by it.
 *
 * Synthetic fixtures only — invented case names and `CAUSE NO. 00-0000-XX`
 * placeholders (CLAUDE.md § Privacy).
 */

import { CorpusStatusTool, CORPUS_STATUS_VERSION } from '../corpus-status';
import { CONFIG, makeContext } from './discovery-harness';

const CASE_ROWS = [
  { id: 'case-aaa', name: 'Nordvale Holdings Bill of Review', caseNumber: 'CAUSE NO. 00-0000-XX' },
  { id: 'case-bbb', name: 'Quill Fabrication Interlocutory Appeal', caseNumber: 'CAUSE NO. 00-0001-XX' },
];

/**
 * A `document.groupBy` double that answers both shapes the tool asks for:
 * `by: ['status']` and `by: ['caseId', 'status']`.
 */
function groupByDouble() {
  return jest.fn().mockImplementation(async (args: any) => {
    const by: string[] = args?.by ?? [];
    if (by.length === 1 && by[0] === 'status') {
      return [
        { status: 'DISCOVERED', _count: { _all: 30 } },
        { status: 'INDEXED', _count: { _all: 10 } },
      ];
    }
    const rows = [
      { caseId: 'case-aaa', status: 'DISCOVERED', _count: { _all: 25 } },
      { caseId: 'case-aaa', status: 'INDEXED', _count: { _all: 5 } },
      { caseId: 'case-bbb', status: 'DISCOVERED', _count: { _all: 5 } },
      { caseId: 'case-bbb', status: 'INDEXED', _count: { _all: 5 } },
    ];
    const want = args?.where?.caseId;
    return want ? rows.filter((r) => r.caseId === want) : rows;
  });
}

function makeDb(overrides: Record<string, any> = {}) {
  return {
    document: {
      groupBy: groupByDouble(),
      count: jest.fn().mockResolvedValue(30),
      aggregate: jest.fn().mockResolvedValue({
        _max: { updatedAt: new Date('2024-03-09T00:00:00.000Z') },
      }),
      ...(overrides.document ?? {}),
    },
    case: {
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const want = args?.where?.id;
        return want ? CASE_ROWS.filter((c) => c.id === want) : CASE_ROWS;
      }),
      ...(overrides.case ?? {}),
    },
    jobLog: {
      findFirst: jest.fn().mockResolvedValue({
        completedAt: new Date('2024-02-28T00:00:00.000Z'),
        documentsQueued: 7,
        documentsProcessed: 6,
        documentsFailed: 1,
      }),
      ...(overrides.jobLog ?? {}),
    },
  };
}

describe('corpus_status', () => {
  const tool = new CorpusStatusTool();

  it('declares a local-safe metadata contract', () => {
    const m = tool.getMetadata();
    expect(m.name).toBe('corpus_status');
    expect(m.profiles).toEqual(['local', 'routed']);
    // `category: 'search'` is load-bearing: tool-registry sets
    // `toolNeedsLlm = category !== 'search'`, and under the `local` profile a
    // non-search tool requires reachable Ollama. A status tool must answer on a
    // degraded fleet — that is when you most need it.
    expect(m.category).toBe('search');
    expect(m.inputSchema.required).toEqual([]);
    expect(Object.keys(m.inputSchema.properties).sort()).toEqual(['caseId', 'includeChunks']);
  });

  it('is callable bare and reports totals, coverage and a version', async () => {
    const ctx = makeContext(makeDb());
    const res = await tool.execute({}, ctx, CONFIG);

    expect(res.success).toBe(true);
    const d = res.data!;
    expect(d.documents.total).toBe(40);
    expect(d.documents.indexed).toBe(10);
    expect(d.corpusCoverage).toBe(0.25);
    expect(d.corpusStatusVersion).toBe(CORPUS_STATUS_VERSION);
  });

  it('buckets by OBSERVED status values, including ones outside the conventional four', async () => {
    const ctx = makeContext(makeDb());
    const res = await tool.execute({}, ctx, CONFIG);

    // DISCOVERED is not among QUEUED/PROCESSING/INDEXED/ERROR, and it is what
    // the live corpus actually uses for un-ingested documents. It must survive.
    expect(res.data!.documents.byStatus).toEqual({ DISCOVERED: 30, INDEXED: 10 });
    expect(Object.keys(res.data!.documents.byStatus)).toContain('DISCOVERED');
  });

  it('reports per-case coverage, which differs sharply from the corpus average', async () => {
    const ctx = makeContext(makeDb());
    const res = await tool.execute({}, ctx, CONFIG);

    const byId = Object.fromEntries(res.data!.cases.map((c) => [c.caseId, c]));
    expect(byId['case-aaa'].coverage).toBeCloseTo(0.167, 3); // 5 / 30
    expect(byId['case-bbb'].coverage).toBe(0.5); //             5 / 10
    // The whole point: a corpus average of 0.25 would mislead a caller scoped
    // to case-aaa by roughly 1.5x.
    expect(byId['case-aaa'].coverage).not.toBe(res.data!.corpusCoverage);
  });

  it('keeps corpus-wide totals when scoped to one case', async () => {
    const ctx = makeContext(makeDb());
    const res = await tool.execute({ caseId: 'case-bbb' }, ctx, CONFIG);

    expect(res.data!.cases).toHaveLength(1);
    expect(res.data!.cases[0].caseId).toBe('case-bbb');
    // A scoped answer still knows its own denominator.
    expect(res.data!.documents.total).toBe(40);
    expect(res.data!.corpusCoverage).toBe(0.25);
  });

  it('keeps the two ingest timestamps separate', async () => {
    const ctx = makeContext(makeDb());
    const res = await tool.execute({}, ctx, CONFIG);

    const ing = res.data!.ingest;
    expect(ing.lastJobCompletedAt).toBe('2024-02-28T00:00:00.000Z');
    expect(ing.lastDocumentUpdatedAt).toBe('2024-03-09T00:00:00.000Z');
    // They diverge — merging them into one "last ingest" field would report the
    // later, wrong one. Measured 9 days apart in production.
    expect(ing.lastJobCompletedAt).not.toBe(ing.lastDocumentUpdatedAt);
    expect(ing.lastJobDocumentsFailed).toBe(1);
  });

  it('survives a corpus with no completed ingest run', async () => {
    const db = makeDb({ jobLog: { findFirst: jest.fn().mockResolvedValue(null) } });
    const res = await tool.execute({}, makeContext(db), CONFIG);

    expect(res.success).toBe(true);
    expect(res.data!.ingest.lastJobCompletedAt).toBeNull();
    expect(res.data!.ingest.lastJobDocumentsQueued).toBeUndefined();
  });

  // The degraded-vector-store cases are forced with an unreadable path rather
  // than relying on LanceDB being absent under jest. It is NOT absent — an
  // earlier version of this suite assumed it was, and the tool returned a bare
  // `0` instead, which is the confident-zero-denominator failure itself.
  describe('with an unreadable vector store', () => {
    const saved = process.env.LANCEDB_PATH;
    beforeEach(() => {
      process.env.LANCEDB_PATH = '/nonexistent/corpus-status-test/lancedb';
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.LANCEDB_PATH;
      else process.env.LANCEDB_PATH = saved;
    });

    it('reports chunks as null with a reason, never 0', async () => {
      const res = await tool.execute({}, makeContext(makeDb()), CONFIG);

      expect(res.success).toBe(true);
      expect(res.data!.chunks.total).toBeNull();
      expect(res.data!.chunks.total).not.toBe(0);
      expect(res.data!.chunks.unavailableReason).toBeTruthy();
      // Document counts must still be returned — the answer degrades, not fails.
      expect(res.data!.documents.total).toBe(40);
    });

    it('marks per-case chunks null under includeChunks', async () => {
      const res = await tool.execute({ includeChunks: true }, makeContext(makeDb()), CONFIG);

      expect(res.success).toBe(true);
      for (const c of res.data!.cases) {
        expect(c.chunks).toBeNull();
      }
    });
  });

  it('refuses to serve a zero chunk count while documents are INDEXED', async () => {
    // The two stores disagreeing is not a measurement of zero. Serving the 0
    // would hand a caller a denominator to divide by.
    const res = await tool.execute({}, makeContext(makeDb()), CONFIG);

    if (res.data!.chunks.total === null) {
      expect(res.data!.chunks.unavailableReason).toBeTruthy();
    }
    expect(res.data!.chunks.total).not.toBe(0);
  });

  it('counts documents missing a pageCount as an ingest-completeness signal', async () => {
    const ctx = makeContext(makeDb());
    const res = await tool.execute({}, ctx, CONFIG);
    expect(res.data!.documents.missingPageCount).toBe(30);
  });
});
