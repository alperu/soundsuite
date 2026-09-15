/**
 * @jest-environment node
 *
 * Unit tests for `computePartialDocumentIds` — the shared "is this document
 * partially indexed?" check.
 *
 * The load-bearing behaviour under test is the blank-page allowance. The two
 * legacy copies of this check (src/app/page.tsx's getPartialDocumentIds and
 * /api/documents/partial-status) compare distinct indexed pages to pageCount
 * with NO allowance for pages that are blank by design, so a document whose
 * only gap is a blank page is badged PARTIAL forever and no amount of
 * re-embedding can clear it. /api/vectors/page-report gets this right at
 * per-page granularity via `source === 'empty'`; this module applies the same
 * rule in batch. These tests pin that rule, plus the PageCache-wins-over-
 * PageScore fallback and the missing-table branch that deliberately skips it.
 *
 * Both injected ports (Prisma, LanceDB) are in-suite fakes: no database, no
 * filesystem, no network. Fixtures are synthetic (CLAUDE.md § Privacy) —
 * invented document ids and small page counts, never real corpus ids.
 */

import {
  computePartialDocumentIds,
  PartialDetectionDoc,
  PartialDetectionLancedb,
  PartialDetectionPrisma,
} from '../partial-detection';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A PageCache/PageScore row as the fake stores it (superset of what the module reads). */
type FakePageRow = { documentId: string; pageNumber: number; source: string };

/** A LanceDB `chunks` row — snake_case, as the real table stores it. */
type FakeChunkRow = { document_id: string; page_number: number };

type PrismaCall = {
  model: 'pageCache' | 'pageScore';
  where: Record<string, unknown>;
  distinct?: string[];
};

type FakePrisma = {
  prisma: PartialDetectionPrisma;
  calls: PrismaCall[];
};

/**
 * Filter-over-flat-rows fake, deliberately NOT a call-order router: the
 * `docsWithPageCache` branch is only meaningfully exercised if the third
 * query (any PageCache row, distinct by document) answers from the same seed
 * as the first (PageCache rows with source 'empty').
 */
function makePrisma(seed: {
  pageCache?: FakePageRow[];
  pageScore?: FakePageRow[];
  failWith?: Error;
}): FakePrisma {
  const calls: PrismaCall[] = [];
  const pageCacheRows = seed.pageCache ?? [];
  const pageScoreRows = seed.pageScore ?? [];

  const run = (
    model: 'pageCache' | 'pageScore',
    rows: FakePageRow[],
    args: { where: Record<string, unknown>; select?: Record<string, boolean>; distinct?: string[] },
  ): FakePageRow[] => {
    calls.push({ model, where: args.where, distinct: args.distinct });
    if (seed.failWith) throw seed.failWith;

    const where = args.where as {
      documentId?: { in?: string[] };
      source?: string;
    };
    const ids = where.documentId?.in;
    let out = rows.filter(
      (r) =>
        (!ids || ids.includes(r.documentId)) &&
        (where.source === undefined || r.source === where.source),
    );

    if (args.distinct?.includes('documentId')) {
      const seen = new Set<string>();
      out = out.filter((r) => (seen.has(r.documentId) ? false : (seen.add(r.documentId), true)));
    }
    return out;
  };

  const prisma: PartialDetectionPrisma = {
    pageCache: { findMany: async (args) => run('pageCache', pageCacheRows, args) },
    pageScore: { findMany: async (args) => run('pageScore', pageScoreRows, args) },
  };

  return { prisma, calls };
}

type FakeLancedb = {
  lancedb: PartialDetectionLancedb;
  calls: {
    connectPaths: string[];
    tableNamesCalls: number;
    openedTables: string[];
    selectedColumns: string[][];
    whereClauses: string[];
  };
};

/**
 * The fake returns every seeded chunk row rather than parsing the SQL `where`
 * clause — the clause is asserted directly instead (see "query construction").
 * Rows for documents outside `docs` are harmless: the module only iterates the
 * documents it was given.
 */
function makeLancedb(seed: {
  tables?: string[];
  rows?: FakeChunkRow[];
  failWith?: Error;
}): FakeLancedb {
  const calls = {
    connectPaths: [] as string[],
    tableNamesCalls: 0,
    openedTables: [] as string[],
    selectedColumns: [] as string[][],
    whereClauses: [] as string[],
  };
  const tables = seed.tables ?? ['chunks'];
  const rows = seed.rows ?? [];

  const lancedb: PartialDetectionLancedb = {
    connect: async (path: string) => {
      calls.connectPaths.push(path);
      if (seed.failWith) throw seed.failWith;
      return {
        tableNames: async () => {
          calls.tableNamesCalls += 1;
          return tables;
        },
        openTable: async (name: string) => {
          calls.openedTables.push(name);
          return {
            query: () => ({
              select: (cols: string[]) => {
                calls.selectedColumns.push(cols);
                return {
                  where: (clause: string) => {
                    calls.whereClauses.push(clause);
                    return { toArray: async () => rows.map((r) => ({ ...r })) };
                  },
                };
              },
            }),
          };
        },
      };
    },
  };

  return { lancedb, calls };
}

/** Build chunk rows for `pages` of `documentId`. */
function chunkRows(documentId: string, pages: number[]): FakeChunkRow[] {
  return pages.map((page_number) => ({ document_id: documentId, page_number }));
}

/** Build PageCache/PageScore rows for `pages` of `documentId`. */
function pageRows(documentId: string, pages: number[], source: string): FakePageRow[] {
  return pages.map((pageNumber) => ({ documentId, pageNumber, source }));
}

const LANCEDB_PATH = './data/test-lancedb';

function run(
  docs: PartialDetectionDoc[],
  prisma: PartialDetectionPrisma,
  lancedb: PartialDetectionLancedb,
  tableName?: string,
): Promise<Set<string>> {
  return computePartialDocumentIds(docs, {
    prisma,
    lancedb,
    lancedbPath: LANCEDB_PATH,
    ...(tableName ? { tableName } : {}),
  });
}

// ---------------------------------------------------------------------------

describe('computePartialDocumentIds', () => {
  describe('short-circuits', () => {
    it('returns an empty set for an empty document list without connecting to LanceDB', async () => {
      const { prisma, calls: prismaCalls } = makePrisma({});
      const { lancedb, calls } = makeLancedb({});

      const partial = await run([], prisma, lancedb);

      expect(partial.size).toBe(0);
      expect(calls.connectPaths).toEqual([]);
      expect(prismaCalls).toEqual([]);
    });

    it('never runs the blank-page lookup when every document is fully indexed', async () => {
      const { prisma, calls: prismaCalls } = makePrisma({});
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1, 2, 3]) });

      const partial = await run([{ id: 'doc-alpha', pageCount: 3 }], prisma, lancedb);

      expect(partial.size).toBe(0);
      // No naive candidates => Prisma is never touched.
      expect(prismaCalls).toEqual([]);
    });
  });

  describe('core coverage', () => {
    it('does not flag a document whose every page is indexed', async () => {
      const { prisma } = makePrisma({});
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1, 2, 3, 4]) });

      const partial = await run([{ id: 'doc-alpha', pageCount: 4 }], prisma, lancedb);

      expect(Array.from(partial)).toEqual([]);
    });

    it('flags a document with a genuinely missing page', async () => {
      // Page 3 has no chunks and no blank-page provenance anywhere.
      const { prisma } = makePrisma({});
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1, 2, 4]) });

      const partial = await run([{ id: 'doc-alpha', pageCount: 4 }], prisma, lancedb);

      expect(Array.from(partial)).toEqual(['doc-alpha']);
    });

    it('counts distinct pages, so several chunks on one page do not cover the document', async () => {
      const { prisma } = makePrisma({});
      const { lancedb } = makeLancedb({
        rows: [...chunkRows('doc-alpha', [1, 1, 1, 1]), ...chunkRows('doc-alpha', [2])],
      });

      const partial = await run([{ id: 'doc-alpha', pageCount: 4 }], prisma, lancedb);

      expect(Array.from(partial)).toEqual(['doc-alpha']);
    });

    it('never flags a document with pageCount 0', async () => {
      const { prisma, calls: prismaCalls } = makePrisma({});
      const { lancedb } = makeLancedb({ rows: [] });

      const partial = await run([{ id: 'doc-empty', pageCount: 0 }], prisma, lancedb);

      expect(partial.size).toBe(0);
      expect(prismaCalls).toEqual([]);
    });

    it('returns only ids drawn from the input list', async () => {
      const { prisma } = makePrisma({});
      const { lancedb } = makeLancedb({
        rows: [...chunkRows('doc-alpha', [1]), ...chunkRows('doc-unrelated', [1, 2, 3])],
      });

      const partial = await run(
        [
          { id: 'doc-alpha', pageCount: 2 },
          { id: 'doc-bravo', pageCount: 2 },
        ],
        prisma,
        lancedb,
      );

      expect(Array.from(partial).sort()).toEqual(['doc-alpha', 'doc-bravo']);
    });

    it('does not mutate the documents it was given', async () => {
      const docs: PartialDetectionDoc[] = [{ id: 'doc-alpha', pageCount: 2 }];
      const snapshot = JSON.parse(JSON.stringify(docs));
      const { prisma } = makePrisma({});
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1]) });

      await run(docs, prisma, lancedb);

      expect(docs).toEqual(snapshot);
    });
  });

  describe('blank-by-design pages (the load-bearing case)', () => {
    it('does NOT flag a document whose only missing pages are blank by design (PageCache.source === "empty")', async () => {
      // 4-page document, pages 1/2/4 indexed. Page 3 is blank by design, so
      // there is nothing to embed and the gap can never be closed by
      // re-indexing. Correct behaviour per page-report semantics: NOT partial.
      const { prisma } = makePrisma({
        pageCache: [
          ...pageRows('doc-alpha', [1, 2, 4], 'extract'),
          ...pageRows('doc-alpha', [3], 'empty'),
        ],
      });
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1, 2, 4]) });

      const partial = await run([{ id: 'doc-alpha', pageCount: 4 }], prisma, lancedb);

      expect(Array.from(partial)).toEqual([]);
    });

    it('still flags a document that has one blank page AND one genuine gap', async () => {
      // Pages 1/2 indexed, page 3 blank by design, page 4 genuinely missing.
      const { prisma } = makePrisma({
        pageCache: [
          ...pageRows('doc-alpha', [1, 2], 'extract'),
          ...pageRows('doc-alpha', [3], 'empty'),
        ],
      });
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1, 2]) });

      const partial = await run([{ id: 'doc-alpha', pageCount: 4 }], prisma, lancedb);

      expect(Array.from(partial)).toEqual(['doc-alpha']);
    });

    it('falls back to PageScore "empty" rows when the document has no PageCache rows left', async () => {
      // PageCache is wiped after a successful ingest; PageScore outlives it.
      const { prisma } = makePrisma({
        pageCache: [],
        pageScore: [
          ...pageRows('doc-alpha', [1, 2], 'extract'),
          ...pageRows('doc-alpha', [3], 'empty'),
        ],
      });
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1, 2]) });

      const partial = await run([{ id: 'doc-alpha', pageCount: 3 }], prisma, lancedb);

      expect(Array.from(partial)).toEqual([]);
    });

    it('ignores PageScore "empty" rows while any PageCache row survives (PageCache wins)', async () => {
      // PageCache still has rows for this document but none marked 'empty',
      // so the PageScore claim that page 3 is blank is deliberately ignored
      // and the document stays partial.
      const { prisma } = makePrisma({
        pageCache: pageRows('doc-alpha', [1, 2], 'extract'),
        pageScore: [
          ...pageRows('doc-alpha', [1, 2], 'extract'),
          ...pageRows('doc-alpha', [3], 'empty'),
        ],
      });
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1, 2]) });

      const partial = await run([{ id: 'doc-alpha', pageCount: 3 }], prisma, lancedb);

      expect(Array.from(partial)).toEqual(['doc-alpha']);
    });

    it('applies the PageCache-wins rule per document, not globally', async () => {
      // doc-alpha still has PageCache rows (PageScore ignored => partial);
      // doc-bravo's PageCache was wiped (PageScore honoured => not partial).
      const { prisma } = makePrisma({
        pageCache: pageRows('doc-alpha', [1, 2], 'extract'),
        pageScore: [...pageRows('doc-alpha', [3], 'empty'), ...pageRows('doc-bravo', [3], 'empty')],
      });
      const { lancedb } = makeLancedb({
        rows: [...chunkRows('doc-alpha', [1, 2]), ...chunkRows('doc-bravo', [1, 2])],
      });

      const partial = await run(
        [
          { id: 'doc-alpha', pageCount: 3 },
          { id: 'doc-bravo', pageCount: 3 },
        ],
        prisma,
        lancedb,
      );

      expect(Array.from(partial)).toEqual(['doc-alpha']);
    });

    it('DOCUMENTED SHARP EDGE: an "empty" row numbered beyond pageCount inflates coverage and masks a real gap', async () => {
      // Page numbers are unioned as raw numbers with no range clamp. Page 3 is
      // genuinely missing, but a stray 'empty' row for page 99 pushes the
      // covered count to pageCount and the document reads as complete.
      const { prisma } = makePrisma({
        pageCache: [
          ...pageRows('doc-alpha', [1, 2], 'extract'),
          ...pageRows('doc-alpha', [99], 'empty'),
        ],
      });
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1, 2]) });

      const partial = await run([{ id: 'doc-alpha', pageCount: 3 }], prisma, lancedb);

      expect(Array.from(partial)).toEqual([]);
    });

    it('does not double-count a page that is both indexed and marked empty', async () => {
      // Coverage is a union, so an 'empty' row for an already-indexed page
      // adds nothing and the genuine gap on page 3 survives.
      const { prisma } = makePrisma({
        pageCache: [
          ...pageRows('doc-alpha', [1], 'extract'),
          ...pageRows('doc-alpha', [2], 'empty'),
        ],
      });
      const { lancedb } = makeLancedb({ rows: chunkRows('doc-alpha', [1, 2]) });

      const partial = await run([{ id: 'doc-alpha', pageCount: 3 }], prisma, lancedb);

      expect(Array.from(partial)).toEqual(['doc-alpha']);
    });
  });

  describe('missing chunks table', () => {
    it('flags every input document when the chunks table is absent — including one that would otherwise be fully covered', async () => {
      const { prisma } = makePrisma({
        pageCache: pageRows('doc-bravo', [1, 2, 3], 'empty'),
      });
      const { lancedb } = makeLancedb({ tables: ['chunks_chat_session_x'] });

      const partial = await run(
        [
          { id: 'doc-alpha', pageCount: 3 },
          { id: 'doc-bravo', pageCount: 3 },
        ],
        prisma,
        lancedb,
      );

      expect(Array.from(partial).sort()).toEqual(['doc-alpha', 'doc-bravo']);
    });

    it('skips the blank-page lookup entirely when the chunks table is absent', async () => {
      const { prisma, calls: prismaCalls } = makePrisma({
        pageCache: pageRows('doc-alpha', [1, 2, 3], 'empty'),
      });
      const { lancedb, calls } = makeLancedb({ tables: [] });

      await run([{ id: 'doc-alpha', pageCount: 3 }], prisma, lancedb);

      expect(prismaCalls).toEqual([]);
      expect(calls.openedTables).toEqual([]);
    });
  });

  describe('query construction', () => {
    it('defaults to the "chunks" table and honours an override', async () => {
      const { prisma } = makePrisma({});
      const defaults = makeLancedb({ rows: chunkRows('doc-alpha', [1]) });
      await run([{ id: 'doc-alpha', pageCount: 1 }], prisma, defaults.lancedb);
      expect(defaults.calls.openedTables).toEqual(['chunks']);
      expect(defaults.calls.connectPaths).toEqual([LANCEDB_PATH]);

      const custom = makeLancedb({ tables: ['alt_chunks'], rows: chunkRows('doc-alpha', [1]) });
      await run([{ id: 'doc-alpha', pageCount: 1 }], prisma, custom.lancedb, 'alt_chunks');
      expect(custom.calls.openedTables).toEqual(['alt_chunks']);
    });

    it('selects the snake_case chunk columns and filters on the requested ids', async () => {
      const { prisma } = makePrisma({});
      const { lancedb, calls } = makeLancedb({ rows: chunkRows('doc-alpha', [1]) });

      await run(
        [
          { id: 'doc-alpha', pageCount: 1 },
          { id: 'doc-bravo', pageCount: 1 },
        ],
        prisma,
        lancedb,
      );

      expect(calls.selectedColumns).toEqual([['document_id', 'page_number']]);
      expect(calls.whereClauses).toEqual(["document_id IN ('doc-alpha', 'doc-bravo')"]);
    });

    it("escapes single quotes in document ids by doubling them", async () => {
      const { prisma } = makePrisma({});
      const { lancedb, calls } = makeLancedb({ rows: [] });

      await run([{ id: "doc-a'b", pageCount: 1 }], prisma, lancedb);

      expect(calls.whereClauses).toEqual(["document_id IN ('doc-a''b')"]);
    });

    it('sends only the naive candidates to the blank-page lookup', async () => {
      // doc-alpha is fully indexed, doc-bravo is not: only doc-bravo should
      // reach Prisma.
      const { prisma, calls: prismaCalls } = makePrisma({});
      const { lancedb } = makeLancedb({
        rows: [...chunkRows('doc-alpha', [1, 2]), ...chunkRows('doc-bravo', [1])],
      });

      await run(
        [
          { id: 'doc-alpha', pageCount: 2 },
          { id: 'doc-bravo', pageCount: 2 },
        ],
        prisma,
        lancedb,
      );

      expect(prismaCalls).toHaveLength(3);
      for (const call of prismaCalls) {
        expect(call.where).toMatchObject({ documentId: { in: ['doc-bravo'] } });
      }
      expect(prismaCalls.filter((c) => c.model === 'pageCache')).toHaveLength(2);
      expect(prismaCalls.filter((c) => c.model === 'pageScore')).toHaveLength(1);
      expect(prismaCalls.some((c) => c.distinct?.includes('documentId'))).toBe(true);
    });
  });

  describe('error propagation (the caller owns the try/catch)', () => {
    it('propagates a LanceDB failure rather than failing open', async () => {
      const { prisma } = makePrisma({});
      const { lancedb } = makeLancedb({ failWith: new Error('lancedb unavailable') });

      await expect(run([{ id: 'doc-alpha', pageCount: 1 }], prisma, lancedb)).rejects.toThrow(
        'lancedb unavailable',
      );
    });

    it('propagates a Prisma failure from the blank-page lookup', async () => {
      const { prisma } = makePrisma({ failWith: new Error('prisma unavailable') });
      const { lancedb } = makeLancedb({ rows: [] });

      await expect(run([{ id: 'doc-alpha', pageCount: 2 }], prisma, lancedb)).rejects.toThrow(
        'prisma unavailable',
      );
    });
  });
});
