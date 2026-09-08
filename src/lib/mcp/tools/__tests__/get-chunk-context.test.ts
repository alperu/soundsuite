/** @jest-environment node */
/**
 * `get_chunk_context` (docs/tasks/19) — covers the acceptance table:
 * mid-document window, both document boundaries, the never-cross-a-document
 * rule, the before/after clamp, and the draft marker on a neighbour.
 *
 * Every fixture is SYNTHETIC: invented parties, `CAUSE NO. 00-0000-XX`
 * placeholders, generic filing titles (CLAUDE.md § Privacy).
 */

import { GetChunkContextTool, MAX_CONTEXT } from '../get-chunk-context';
import type { ToolConfigEntry, ToolExecutionContext } from '../../tool-types';
import type { SearchResult } from '../../../vector/vector-store';

const CONFIG: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

// ---------------------------------------------------------------------------
// Synthetic chunk rows
// ---------------------------------------------------------------------------

function row(over: {
  chunkId: string;
  text: string;
  documentId?: string;
  chunkIndex: number;
  pageNumber?: number;
  caseId?: string;
  isExhibit?: boolean;
  exhibitPath?: string;
  recordStatus?: 'filed' | 'draft';
  headingPath?: string;
}): SearchResult {
  const { chunkId, text, ...meta } = over;
  return {
    chunkId,
    text,
    score: 0,
    metadata: {
      documentId: 'doc-1',
      caseId: 'case-aaa',
      pageNumber: 1,
      isExhibit: false,
      ...meta,
    } as SearchResult['metadata'],
  };
}

/** Document A: chunk_index 0..4. Document B: a decoy at the same indices. */
const DOC_A: SearchResult[] = [0, 1, 2, 3, 4].map((i) =>
  row({ chunkId: `a-${i}`, text: `Alpha chunk ${i}`, chunkIndex: i, pageNumber: i + 1 }),
);
const DOC_B: SearchResult[] = [0, 1, 2, 3, 4].map((i) =>
  row({
    chunkId: `b-${i}`,
    text: `Beta chunk ${i}`,
    documentId: 'doc-2',
    chunkIndex: i,
    pageNumber: i + 1,
  }),
);

// ---------------------------------------------------------------------------
// A chunk store that actually evaluates the clauses the tool emits.
// ---------------------------------------------------------------------------

function makeStore(rows: SearchResult[]) {
  const scanTextColumn = jest.fn(
    async ({ filter, limit }: { filter?: Record<string, any>; limit: number }) => {
      let out = rows;
      if (filter?.documentId) {
        out = out.filter((r) => r.metadata.documentId === filter.documentId);
      }
      for (const w of (filter?._rawWhere ?? []) as string[]) {
        let m: RegExpExecArray | null;
        if ((m = /^id = "(.*)"$/.exec(w))) {
          const id = m[1];
          out = out.filter((r) => r.chunkId === id);
        } else if ((m = /^is_exhibit = (true|false)$/.exec(w))) {
          const want = m[1] === 'true';
          out = out.filter((r) => !!r.metadata.isExhibit === want);
        } else if ((m = /^exhibit_path = "(.*)"$/.exec(w))) {
          const p = m[1];
          out = out.filter((r) => r.metadata.exhibitPath === p);
        } else if ((m = /^chunk_index (>=|<=|>|<|=) (-?\d+)$/.exec(w))) {
          const op = m[1];
          const n = Number(m[2]);
          out = out.filter((r) => {
            const i = Number(r.metadata.chunkIndex);
            return op === '>=' ? i >= n
              : op === '<=' ? i <= n
              : op === '>' ? i > n
              : op === '<' ? i < n
              : i === n;
          });
        } else {
          throw new Error(`unhandled where clause in test store: ${w}`);
        }
      }
      return out.slice(0, limit);
    },
  );
  return { scanTextColumn };
}

function makeContext(
  rows: SearchResult[],
  docOverrides: Record<string, unknown> = {},
) {
  const store = makeStore(rows);
  const database = {
    document: {
      findUnique: jest.fn().mockResolvedValue({
        fileName: 'motion.pdf',
        filing: null,
        case: { id: 'case-aaa', caseNumber: 'CAUSE NO. 00-0000-XX' },
        documentType: 'Motion',
        tags: {},
        ...docOverrides,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    case: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'case-aaa', caseNumber: 'CAUSE NO. 00-0000-XX', state: 'TX' }]),
    },
    filing: { findMany: jest.fn().mockResolvedValue([]) },
    motion: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const context = {
    vectorStore: store as any,
    embeddingProvider: {} as any,
    database: database as any,
    logger: makeLogger() as any,
    profile: 'local',
  } as unknown as ToolExecutionContext;
  return { context, store, database };
}

const tool = new GetChunkContextTool();

// ---------------------------------------------------------------------------

describe('get_chunk_context metadata', () => {
  it('is exposed to both profiles and rejects unknown params', async () => {
    const meta = tool.getMetadata();
    expect(meta.name).toBe('get_chunk_context');
    expect(meta.profiles).toEqual(['local', 'routed']);
    expect(meta.inputSchema.required).toEqual(['chunkId']);

    const { context } = makeContext(DOC_A);
    const res = await tool.execute(
      { chunkId: 'a-2', context: 2 } as any,
      context,
      CONFIG,
    );
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toMatch(/unknown parameter/);
  });

  it('says in its description that chunk_index is per-document and that it never crosses documents', () => {
    const d = tool.getMetadata().description;
    expect(d).toMatch(/per-document/);
    expect(d).toMatch(/never crosses a document boundary/);
    expect(d).toMatch(/DRAFT/);
  });

  it('is registered in getAllTools', async () => {
    const { getAllTools } = await import('../index');
    expect(getAllTools().some((t) => t.getMetadata().name === 'get_chunk_context')).toBe(true);
  });
});

describe('get_chunk_context windowing', () => {
  it('mid-document, before:1 after:1 → three chunks with the target marked', async () => {
    const { context } = makeContext(DOC_A);
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 1, after: 1 }, context, CONFIG);

    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(out.chunks.filter((c) => c.isTarget).map((c) => c.chunkId)).toEqual(['a-2']);
    expect(out.chunks.map((c) => c.position)).toEqual(['before', 'target', 'after']);
    expect(out.atDocumentStart).toBe(false);
    expect(out.atDocumentEnd).toBe(false);
    expect(out.returnedBefore).toBe(1);
    expect(out.returnedAfter).toBe(1);
  });

  it('defaults to one either side', async () => {
    const { context } = makeContext(DOC_A);
    const out = await tool.executeImpl({ chunkId: 'a-2' }, context, CONFIG);
    expect(out.chunks).toHaveLength(3);
    expect(out.effectiveBefore).toBe(1);
    expect(out.effectiveAfter).toBe(1);
  });

  it('before:0 after:0 returns the target alone', async () => {
    const { context } = makeContext(DOC_A);
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 0, after: 0 }, context, CONFIG);
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a-2']);
  });

  it('carries citation and provenance fields on every chunk, not just the target', async () => {
    const rows = DOC_A.map((r, i) =>
      i === 1 ? row({ chunkId: 'a-1', text: 'Alpha chunk 1', chunkIndex: 1, pageNumber: 2, headingPath: 'II. Argument' }) : r,
    );
    const { context } = makeContext(rows);
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 1, after: 1 }, context, CONFIG);
    for (const c of out.chunks) {
      expect(typeof c.citation).toBe('string');
      expect(typeof c.citationShort).toBe('string');
      expect(c.documentId).toBe('doc-1');
      expect(c.caseId).toBe('case-aaa');
      expect(typeof c.page).toBe('number');
    }
    expect(out.chunks.find((c) => c.chunkId === 'a-1')!.headingPath).toBe('II. Argument');
  });

  it('omits caseId when neither the chunk row nor the document carries one (query_case_knowledge parity)', async () => {
    const rows = [1, 2, 3].map((i) =>
      row({ chunkId: `a-${i}`, text: `Alpha chunk ${i}`, chunkIndex: i, pageNumber: i, caseId: undefined }),
    );
    const { context } = makeContext(rows, { case: null });
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 1, after: 1 }, context, CONFIG);
    expect(out.caseId).toBeUndefined();
    expect(out.chunks.every((c) => c.caseId === undefined)).toBe(true);
    // Citations still format off the corpus default rather than failing.
    expect(out.chunks.every((c) => typeof c.citation === 'string')).toBe(true);
  });
});

describe('get_chunk_context document boundaries', () => {
  it('the first chunk of a document: no preceding chunk, and the response says so', async () => {
    const { context } = makeContext(DOC_A);
    const out = await tool.executeImpl({ chunkId: 'a-0', before: 2, after: 1 }, context, CONFIG);

    expect(out.chunks.some((c) => c.position === 'before')).toBe(false);
    expect(out.returnedBefore).toBe(0);
    expect(out.atDocumentStart).toBe(true);
    expect(out.atDocumentEnd).toBe(false);
    expect(out.notes.join(' ')).toMatch(/first chunk of this document/);
    expect(out.chunks[0].isTarget).toBe(true);
  });

  it('the last chunk of a document: no following chunk, and the response says so', async () => {
    const { context } = makeContext(DOC_A);
    const out = await tool.executeImpl({ chunkId: 'a-4', before: 1, after: 2 }, context, CONFIG);

    expect(out.chunks.some((c) => c.position === 'after')).toBe(false);
    expect(out.returnedAfter).toBe(0);
    expect(out.atDocumentEnd).toBe(true);
    expect(out.atDocumentStart).toBe(false);
    expect(out.notes.join(' ')).toMatch(/last chunk of this document/);
  });

  it('never returns a neighbour from another document, even at matching chunk_index', async () => {
    const { context } = makeContext([...DOC_A, ...DOC_B]);
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 3, after: 3 }, context, CONFIG);
    expect(out.chunks.every((c) => c.documentId === 'doc-1')).toBe(true);
    expect(out.chunks.map((c) => c.chunkId)).not.toContain('b-1');
    expect(out.chunks.map((c) => c.chunkId)).not.toContain('b-3');
  });

  it('drops a foreign-document row even if the store ignores the documentId filter', async () => {
    const leaky = {
      scanTextColumn: jest.fn(async ({ filter, limit }: any) => {
        // Target lookup still resolves by id; every other call leaks doc-2.
        const idClause = (filter?._rawWhere ?? []).find((w: string) => w.startsWith('id = '));
        if (idClause) return [DOC_A[2]];
        return [...DOC_A, ...DOC_B].slice(0, limit);
      }),
    };
    const { context } = makeContext(DOC_A);
    (context as any).vectorStore = leaky;
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 3, after: 3 }, context, CONFIG);
    expect(out.chunks.every((c) => c.documentId === 'doc-1')).toBe(true);
  });

  it('keeps an exhibit target inside its own exhibit stream', async () => {
    // Exhibit chunk_index restarts at 0 per exhibit, so the body stream and two
    // exhibits all carry index 0/1 inside the same document.
    const rows: SearchResult[] = [
      ...DOC_A,
      row({ chunkId: 'ex1-0', text: 'Exhibit one, first', chunkIndex: 0, isExhibit: true, exhibitPath: '/ex/one.png' }),
      row({ chunkId: 'ex1-1', text: 'Exhibit one, second', chunkIndex: 1, isExhibit: true, exhibitPath: '/ex/one.png' }),
      row({ chunkId: 'ex2-0', text: 'Exhibit two, first', chunkIndex: 0, isExhibit: true, exhibitPath: '/ex/two.png' }),
      row({ chunkId: 'ex2-1', text: 'Exhibit two, second', chunkIndex: 1, isExhibit: true, exhibitPath: '/ex/two.png' }),
    ];
    const { context } = makeContext(rows);
    const out = await tool.executeImpl({ chunkId: 'ex1-1', before: 1, after: 1 }, context, CONFIG);
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['ex1-0', 'ex1-1']);
    expect(out.atDocumentEnd).toBe(true);
  });

  it('a boundary is decided by an existence probe, not by a short window', async () => {
    // Only chunk_index 0 and 3 survive. 3 is not at the start, and the probe —
    // not the window length — is what establishes that.
    const holed = [DOC_A[0], DOC_A[3]];
    const { context } = makeContext(holed);
    const out = await tool.executeImpl({ chunkId: 'a-3', before: 1, after: 1 }, context, CONFIG);
    expect(out.atDocumentStart).toBe(false);
    expect(out.atDocumentEnd).toBe(true);
  });
});

describe('get_chunk_context adjacency across gaps', () => {
  // chunk_index is NOT contiguous: measured at 68 non-consecutive pairs out of
  // 35,786 on the live index. A neighbour is the adjacent ROW, not index ± 1.
  const holed = [
    row({ chunkId: 'a-0', text: 'Alpha chunk 0', chunkIndex: 0, pageNumber: 1 }),
    row({ chunkId: 'a-7', text: 'Alpha chunk 7', chunkIndex: 7, pageNumber: 4 }),
    row({ chunkId: 'a-8', text: 'Alpha chunk 8', chunkIndex: 8, pageNumber: 5 }),
  ];

  it('returns the neighbour across a gap rather than nothing', async () => {
    const { context } = makeContext(holed);
    const out = await tool.executeImpl({ chunkId: 'a-7', before: 1, after: 1 }, context, CONFIG);
    // index arithmetic would have asked for 6 and 8 and found only 8.
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a-0', 'a-7', 'a-8']);
    expect(out.returnedBefore).toBe(1);
  });

  it('flags the non-adjacency instead of implying continuity', async () => {
    const { context } = makeContext(holed);
    const out = await tool.executeImpl({ chunkId: 'a-7', before: 1, after: 1 }, context, CONFIG);
    expect(out.contiguous).toBe(false);
    expect(out.chunks.find((c) => c.chunkId === 'a-7')!.indexGapFromPrevious).toBe(7);
    // The properly consecutive pair carries no gap marker.
    expect(out.chunks.find((c) => c.chunkId === 'a-8')!.indexGapFromPrevious).toBeUndefined();
    expect(out.notes.join(' ')).toMatch(/not consecutive/);
    expect(out.notes.join(' ')).toMatch(/Text may be missing between them/);
  });

  it('reports contiguous:true and no gap markers when indices really are consecutive', async () => {
    const { context } = makeContext(DOC_A);
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 1, after: 1 }, context, CONFIG);
    expect(out.contiguous).toBe(true);
    expect(out.chunks.every((c) => c.indexGapFromPrevious === undefined)).toBe(true);
    expect(out.notes.join(' ')).not.toMatch(/not consecutive/);
  });

  it('widens its search rather than giving up on a large gap', async () => {
    // A gap of 200 indices — wider than the first span the tool tries.
    const wide = [
      row({ chunkId: 'a-0', text: 'Alpha chunk 0', chunkIndex: 0, pageNumber: 1 }),
      row({ chunkId: 'a-200', text: 'Alpha chunk 200', chunkIndex: 200, pageNumber: 60 }),
    ];
    const { context } = makeContext(wide);
    const out = await tool.executeImpl({ chunkId: 'a-200', before: 1, after: 0 }, context, CONFIG);
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a-0', 'a-200']);
    expect(out.contiguous).toBe(false);
    expect(out.chunks[1].indexGapFromPrevious).toBe(200);
  });

  /**
   * LanceDB has no ORDER BY, so a query that hits its `limit` returns an
   * arbitrary subset of the span. This store hands back the FARTHEST rows
   * first, so a tool that trusted a truncated wide span would name a distant
   * chunk as "the neighbour" and give it a confidently wrong gap.
   */
  function adversarialStore(rows: SearchResult[]) {
    const base = makeStore(rows);
    return {
      scanTextColumn: jest.fn(async (args: any) => {
        const all = await base.scanTextColumn({ ...args, limit: Number.MAX_SAFE_INTEGER });
        return [...all]
          .sort((a, b) => Number(a.metadata.chunkIndex) - Number(b.metadata.chunkIndex))
          .slice(0, args.limit);
      }),
    };
  }

  /** `copies` rows at each index in [from, to], plus the target above them. */
  function denseRows(from: number, to: number, copies: number, targetIndex: number) {
    const out: SearchResult[] = [];
    for (let i = from; i <= to; i++) {
      for (let c = 0; c < copies; c++) {
        out.push(row({ chunkId: `d-${i}-${c}`, text: `Dense ${i}/${c}`, chunkIndex: i, pageNumber: 1 }));
      }
    }
    out.push(row({ chunkId: 'target', text: 'Target chunk', chunkIndex: targetIndex, pageNumber: 2 }));
    return out;
  }

  it('narrows instead of trusting a capped, unordered slice in a dense region', async () => {
    // 5 rows at each of indices 685..699 = 75 rows in the first 16-index span,
    // over that span's 64-row cap. Narrowing to 4 indices brings it under.
    const dense = denseRows(685, 699, 5, 700);
    const { context } = makeContext(dense);
    (context as any).vectorStore = adversarialStore(dense);

    const out = await tool.executeImpl({ chunkId: 'target', before: 1, after: 0 }, context, CONFIG);
    const neighbour = out.chunks.find((c) => c.position === 'before')!;
    // The true nearest index is 699, not the distant row a truncated wide span
    // would have surfaced.
    expect(neighbour.chunkIndex).toBe(699);
    expect(out.contiguous).toBe(true);
    expect(out.notes.join(' ')).not.toMatch(/may not be the closest/);
    // It really did narrow rather than accept the first answer: more than one
    // before-side span query, each narrower than the last.
    const spans = (context.vectorStore as any).scanTextColumn.mock.calls
      .map((c: any[]) => /chunk_index >= (-?\d+)/.exec((c[0].filter?._rawWhere ?? []).join(' ')))
      .filter(Boolean)
      .map((m: RegExpExecArray) => 700 - Number(m[1]));
    expect(spans.length).toBeGreaterThan(1);
    expect(spans[1]).toBeLessThan(spans[0]);
  });

  it('says so when even the narrowest span is denser than the row cap', async () => {
    // 40 rows at every index: the minimum 4-index span still exceeds its cap,
    // so the tool cannot prove it found the closest neighbour and says that.
    const dense = denseRows(690, 699, 40, 700);
    const { context } = makeContext(dense);
    (context as any).vectorStore = adversarialStore(dense);

    const out = await tool.executeImpl({ chunkId: 'target', before: 1, after: 0 }, context, CONFIG);
    expect(out.notes.join(' ')).toMatch(/may not be the closest/);
    expect(out.orderingAmbiguous).toBe(true);
  });

  it('does not widen at all when the probe says the side is empty', async () => {
    const { context, store } = makeContext(DOC_A);
    await tool.executeImpl({ chunkId: 'a-0', before: 3, after: 0 }, context, CONFIG);
    const spans = store.scanTextColumn.mock.calls
      .map((c: any[]) => (c[0].filter?._rawWhere ?? []).join(' '))
      .filter((w: string) => /chunk_index >= -/.test(w));
    expect(spans).toEqual([]);
  });
});

describe('get_chunk_context clamping', () => {
  it('before: 99 is clamped, not honoured, and the clamp is visible in the response', async () => {
    const many: SearchResult[] = Array.from({ length: 40 }, (_, i) =>
      row({ chunkId: `a-${i}`, text: `Alpha chunk ${i}`, chunkIndex: i, pageNumber: i + 1 }),
    );
    const { context } = makeContext(many);
    const out = await tool.executeImpl({ chunkId: 'a-20', before: 99, after: 99 }, context, CONFIG);

    expect(out.effectiveBefore).toBe(MAX_CONTEXT);
    expect(out.effectiveAfter).toBe(MAX_CONTEXT);
    expect(out.requestedBefore).toBe(99);
    expect(out.maxContext).toBe(MAX_CONTEXT);
    expect(out.chunks).toHaveLength(MAX_CONTEXT * 2 + 1);
    expect(out.notes.join(' ')).toMatch(/before was clamped from 99 to 3/);
    expect(out.notes.join(' ')).toMatch(/after was clamped from 99 to 3/);
  });

  it('a negative count clamps to zero', async () => {
    const { context } = makeContext(DOC_A);
    const out = await tool.executeImpl({ chunkId: 'a-2', before: -5, after: 1 }, context, CONFIG);
    expect(out.effectiveBefore).toBe(0);
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a-2', 'a-3']);
  });
});

describe('get_chunk_context draft guard', () => {
  it('a draft neighbour keeps its marker while a filed target does not gain one', async () => {
    const rows: SearchResult[] = [
      row({ chunkId: 'a-1', text: 'Preceding text', chunkIndex: 1, pageNumber: 2, recordStatus: 'draft' }),
      row({ chunkId: 'a-2', text: 'Target text', chunkIndex: 2, pageNumber: 3, recordStatus: 'filed' }),
      row({ chunkId: 'a-3', text: 'Following text', chunkIndex: 3, pageNumber: 4, recordStatus: 'filed' }),
    ];
    const { context } = makeContext(rows);
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 1, after: 1 }, context, CONFIG);

    const draft = out.chunks.find((c) => c.chunkId === 'a-1')!;
    const target = out.chunks.find((c) => c.isTarget)!;
    expect(draft.recordStatus).toBe('draft');
    expect(draft.citation).toMatch(/DRAFT, filing not confirmed$/);
    expect(draft.citationShort).toMatch(/DRAFT, filing not confirmed$/);
    expect(target.recordStatus).toBe('filed');
    expect(target.citation).not.toMatch(/DRAFT/);

    expect(out.containsDraft).toBe(true);
    expect(out.notes.join(' ')).toMatch(/DRAFT/);
    expect(out.notes.join(' ')).toMatch(/never be presented|not merge its text|Do not merge/i);
  });

  it('falls back to Document.tags.recordStatus for chunks indexed before the column existed', async () => {
    const { context } = makeContext(DOC_A, { tags: { recordStatus: 'draft', recordStatusConfidence: 0.9 } });
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 1, after: 1 }, context, CONFIG);
    expect(out.chunks.every((c) => c.recordStatus === 'draft')).toBe(true);
    expect(out.chunks.every((c) => /DRAFT, filing not confirmed$/.test(c.citation!))).toBe(true);
    expect(out.containsDraft).toBe(true);
  });
});

describe('get_chunk_context errors', () => {
  it('an unknown chunk id is NOT_FOUND, not a leak', async () => {
    const { context } = makeContext(DOC_A);
    const res = await tool.execute({ chunkId: 'a-999' }, context, CONFIG);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('NOT_FOUND');
    expect(res.error).toMatch(/No indexed chunk/);
  });

  it('rejects a chunkId that is not id-shaped rather than interpolating it', async () => {
    const { context, store } = makeContext(DOC_A);
    const res = await tool.execute({ chunkId: 'a-2" OR is_exhibit = true OR id = "x' }, context, CONFIG);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(store.scanTextColumn).not.toHaveBeenCalled();
  });

  it('rejects a non-string chunkId and a non-integer before', async () => {
    const { context } = makeContext(DOC_A);
    expect((await tool.execute({ chunkId: ['a-2'] } as any, context, CONFIG)).errorCode).toBe('INVALID_PARAMS');
    expect((await tool.execute({ chunkId: 'a-2', before: 1.5 } as any, context, CONFIG)).errorCode).toBe('INVALID_PARAMS');
  });

  it('requires chunkId', async () => {
    const { context } = makeContext(DOC_A);
    const res = await tool.execute({} as any, context, CONFIG);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/chunkId is required/);
  });
});

describe('get_chunk_context ordering honesty', () => {
  it('reports ambiguity when two chunks in the window share a chunk_index', async () => {
    const rows: SearchResult[] = [
      ...DOC_A,
      row({ chunkId: 'a-1b', text: 'Duplicate index 1', chunkIndex: 1, pageNumber: 2 }),
    ];
    const { context } = makeContext(rows);
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 1, after: 1 }, context, CONFIG);
    expect(out.orderingAmbiguous).toBe(true);
    expect(out.notes.join(' ')).toMatch(/shares a chunk_index/);
    expect(out.chunks).toHaveLength(3);
  });

  it('flags a document holding two generations of chunks at the target index', async () => {
    // The partial-reindex signature: reindex-pages re-chunks with a counter
    // that restarts at 0, so a stale generation collides on chunk_index.
    const rows: SearchResult[] = [
      ...DOC_A,
      row({ chunkId: 'a-2-stale', text: 'Stale generation at index 2', chunkIndex: 2, pageNumber: 9 }),
    ];
    const { context } = makeContext(rows);
    const out = await tool.executeImpl({ chunkId: 'a-2', before: 1, after: 1 }, context, CONFIG);
    expect(out.orderingAmbiguous).toBe(true);
    expect(out.notes.join(' ')).toMatch(/share the target's chunk_index/);
    expect(out.notes.join(' ')).toMatch(/more than one generation of chunks/);
    // The twin is neither before nor after the target, so it is not returned.
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a-1', 'a-2', 'a-3']);
  });

  it('states the per-document ordering on every response', async () => {
    const { context } = makeContext(DOC_A);
    const out = await tool.executeImpl({ chunkId: 'a-2' }, context, CONFIG);
    expect(out.ordering).toMatch(/document_id then chunk_index/);
    expect(out.ordering).toMatch(/per-document/);
  });
});
