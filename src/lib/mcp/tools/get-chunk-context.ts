/**
 * `get_chunk_context` — return the chunks immediately before and after a
 * retrieved chunk (docs/tasks/19-chunk-context-tool.md).
 *
 * Read-only. No LLM, no reindex, both profiles.
 *
 * ## What `chunk_index` actually orders
 *
 * It is a **per-document** counter, not a global one. Every chunker resets it
 * to 0 at the top of `chunkPages()` (`legal-text-splitter.ts`,
 * `text-chunker.ts`, `langchain-text-chunker.ts`) and increments across the
 * document's pages, so within one document the order is page order then
 * within-page split order. Ordering is therefore `document_id` **then**
 * `chunk_index`; the number alone means nothing across documents.
 *
 * Worse, `(document_id, chunk_index)` is not unique either:
 * `chunkExhibitText()` restarts the counter at 0 for **each exhibit**, and the
 * pipeline concatenates every exhibit's chunks into the document's array
 * without renumbering. Measured on a local index: 623 duplicate
 * `(document_id, chunk_index)` pairs out of 35,890 rows, falling to 172 once
 * the exhibit stream is separated out. So the neighbour window is constrained
 * to the target's own stream (`is_exhibit`, plus `exhibit_path` for exhibit
 * chunks) and any residual ambiguity is reported rather than guessed at.
 *
 * ## Invariants
 *
 * 1. Neighbours never cross a document boundary — the window is filtered on
 *    `documentId` in the query AND re-checked in JS.
 * 2. `before` / `after` are clamped to `MAX_CONTEXT` each, and the effective
 *    values are echoed back so a caller can see the clamp happened.
 * 3. The draft guard survives: every chunk carries its own `recordStatus` and
 *    its own citation, draft citations keep the DRAFT marker, and a
 *    response-level `containsDraft` flag warns against assembling the window
 *    into one quotation that launders a draft into the record.
 */

import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import { McpError } from '../llm-policy';
import type { SearchResult } from '../../vector/vector-store';
import type { CitationInput } from '../../citations/citation-formatter';
import { detectLineNumbers } from '../../citations/line-number-detector';
import { recordStatusFromTags } from '../../ingestion/draft-detector';
import { DRAFT_CITE_MARKER } from '../../search/context-builder';
import { pickProvenance } from '../../search/chunk-provenance';
import { attachMotionIds } from '../motion-resolution';
import {
  buildCaseCitationContexts,
  defaultCitationContext,
  type CaseCitationContext,
} from '../case-citation-context';

/** Hard cap on `before` and `after`, each. Item 2 of the task. */
export const MAX_CONTEXT = 3;

/**
 * Chunk ids are generated as `${Date.now()}-${base36}` (`VectorStore.generateId`),
 * and older rows use uuid-ish forms. This charset covers both and keeps the
 * value safe to interpolate into the `_rawWhere` escape hatch, which is
 * documented as "already SQL-escaped at the call site".
 */
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

export interface GetChunkContextParams {
  chunkId: string;
  before?: number;
  after?: number;
}

export interface ChunkContextEntry {
  chunkId: string;
  text: string;
  page: number;
  chunkIndex: number;
  documentId: string;
  caseId?: string;
  /** True for exactly one entry — the chunk the caller asked about. */
  isTarget: boolean;
  /** Where this entry sits relative to the target. */
  position: 'before' | 'target' | 'after';
  citation?: string;
  citationShort?: string;
  filingType?: string;
  volumeNumber?: number;
  caseNumber?: string;
  motionId?: string;
  filingSlug?: string;
  isExhibit?: boolean;
  startLine?: number;
  endLine?: number;
  /**
   * Distance in `chunk_index` from the previous entry in `chunks`, present only
   * when it is NOT 1 — i.e. when the two chunks are adjacent ROWS in the index
   * but not adjacent indices. Text may be missing between them. Absent on the
   * first entry and whenever the pair is properly consecutive.
   */
  indexGapFromPrevious?: number;
  /** Structure provenance (blockType / headingPath / speakers / tableMarkdown /
   *  recordStatus) — spread from `pickProvenance`, never re-listed by hand. */
  blockType?: string;
  headingPath?: string;
  speakers?: string;
  tableMarkdown?: string;
  recordStatus?: 'filed' | 'draft' | 'unknown';
}

export interface GetChunkContextResult {
  /** File name of the one document every returned chunk belongs to. */
  document: string;
  documentId: string;
  caseId?: string;
  /** Target first in document order, i.e. before… target… after. */
  chunks: ChunkContextEntry[];
  requestedBefore: number;
  requestedAfter: number;
  /** After clamping to `maxContext`. Compare with `requested*` to see a clamp. */
  effectiveBefore: number;
  effectiveAfter: number;
  maxContext: number;
  returnedBefore: number;
  returnedAfter: number;
  /** True when no chunk precedes the target in this document — not merely
   *  when none was returned. Established by its own existence probe, because
   *  `chunk_index` can have holes (page deletes) and a short window is not
   *  proof of a boundary. */
  atDocumentStart: boolean;
  atDocumentEnd: boolean;
  /**
   * True when every returned chunk's `chunk_index` is exactly one more than the
   * previous one's. False means the returned chunks are adjacent ROWS in the
   * index but their indices skip, so text may be missing between them — check
   * `indexGapFromPrevious` on each chunk before assembling a quotation.
   */
  contiguous: boolean;
  /** True when at least one returned chunk is from a draft. */
  containsDraft: boolean;
  /** True when more than one row shares a `chunk_index` in this window, so the
   *  neighbour order is not fully determined by the stored index. */
  orderingAmbiguous: boolean;
  /** Plain-language statement of what happened — boundaries, clamps, drafts. */
  notes: string[];
  /** Fixed string documenting the ordering the tool used. */
  ordering: string;
}

const ORDERING_NOTE =
  'Ordered by document_id then chunk_index. chunk_index is per-document (it restarts at 0 in every document), so it is only comparable within one document.';

/** LanceDB stores `chunk_index` as an integer that can surface as BigInt. */
function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}

/** Document order within one stream: index, then page, then id for stability. */
function compareRows(a: SearchResult, b: SearchResult): number {
  return (
    num(a.metadata.chunkIndex) - num(b.metadata.chunkIndex) ||
    num(a.metadata.pageNumber) - num(b.metadata.pageNumber) ||
    a.chunkId.localeCompare(b.chunkId)
  );
}

export class GetChunkContextTool extends BaseMCPTool<
  GetChunkContextParams,
  GetChunkContextResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'get_chunk_context',
      displayName: 'Get Chunk Context',
      description:
        'Return the chunks immediately before and after a chunk you already have, so a ' +
        'passage that runs past a chunk edge can be read whole. Pass a chunkId from ' +
        'query_case_knowledge or scan_for_pattern. Neighbours come from the SAME document ' +
        'only — this tool never crosses a document boundary, and it reports ' +
        'atDocumentStart / atDocumentEnd when the target sits at either end. Ordering is ' +
        'document_id then chunk_index; chunk_index is per-document (it restarts at 0 in ' +
        'every document) and is not comparable across documents. Neighbours are the ' +
        'adjacent ROWS, not chunk_index plus or minus one, because the index has gaps. ' +
        'When the returned indices are not consecutive the response sets contiguous:false ' +
        'and each affected chunk carries indexGapFromPrevious — text may be missing ' +
        'between them, so do not present such a run as one uninterrupted passage. ' +
        '`before` and `after` are ' +
        `capped at ${MAX_CONTEXT} each so a whole document cannot be pulled through this ` +
        'tool; the effective values are echoed back. Each returned chunk carries its own ' +
        'citation and recordStatus: a DRAFT neighbour is an unfiled working copy, its ' +
        'citation is suffixed "DRAFT, filing not confirmed", and text from it must never ' +
        'be merged into a quotation presented as the filed record. Cost note: three chunks ' +
        'either side of a 2,000-character chunk is a large result.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: {
        type: 'object',
        properties: {
          chunkId: {
            type: 'string',
            description:
              'Chunk id to centre the window on, as returned by query_case_knowledge or scan_for_pattern.',
          },
          before: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_CONTEXT,
            description: `How many preceding chunks to return (default 1, clamped to ${MAX_CONTEXT}).`,
          },
          after: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_CONTEXT,
            description: `How many following chunks to return (default 1, clamped to ${MAX_CONTEXT}).`,
          },
        },
        required: ['chunkId'],
      },
    };
  }

  protected rejectsUnknownParams(): boolean {
    return true;
  }

  validateParams(params: GetChunkContextParams): void {
    if (!SAFE_ID.test(params.chunkId)) {
      throw new McpError(
        'INVALID_PARAMS',
        'chunkId must be an id as returned by a search tool (letters, digits, ".", "_", ":", "-").',
      );
    }
  }

  async executeImpl(
    params: GetChunkContextParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<GetChunkContextResult> {
    const store = context.vectorStore as any;
    if (!store || typeof store.scanTextColumn !== 'function') {
      throw new McpError(
        'NOT_FOUND',
        'The chunk store does not support direct chunk lookup on this deployment.',
      );
    }

    const requestedBefore = params.before === undefined ? 1 : params.before;
    const requestedAfter = params.after === undefined ? 1 : params.after;
    const effectiveBefore = clamp(requestedBefore);
    const effectiveAfter = clamp(requestedAfter);

    const notes: string[] = [];
    if (effectiveBefore !== requestedBefore) {
      notes.push(
        `before was clamped from ${requestedBefore} to ${effectiveBefore} (maximum ${MAX_CONTEXT}).`,
      );
    }
    if (effectiveAfter !== requestedAfter) {
      notes.push(
        `after was clamped from ${requestedAfter} to ${effectiveAfter} (maximum ${MAX_CONTEXT}).`,
      );
    }

    // ---- 1. The target chunk ------------------------------------------------
    const targetRows: SearchResult[] = await store.scanTextColumn({
      filter: { _rawWhere: [`id = "${params.chunkId}"`] },
      limit: 2,
    });
    const target = targetRows[0];
    if (!target) {
      throw new McpError(
        'NOT_FOUND',
        `No indexed chunk with id "${params.chunkId}". Chunk ids come from query_case_knowledge or scan_for_pattern results and change when a document is reindexed.`,
      );
    }

    const documentId = target.metadata.documentId;
    const targetIndex = num(target.metadata.chunkIndex);
    const isExhibit = !!target.metadata.isExhibit;
    const exhibitPath = target.metadata.exhibitPath;

    // ---- 2. Stream constraint ----------------------------------------------
    // `(document_id, chunk_index)` is NOT unique: exhibit chunks restart the
    // counter per exhibit. Keep the window inside the target's own stream.
    const streamWhere: string[] = [`is_exhibit = ${isExhibit}`];
    if (isExhibit) {
      if (exhibitPath && !/["\\]/.test(exhibitPath)) {
        streamWhere.push(`exhibit_path = "${exhibitPath}"`);
      } else {
        notes.push(
          'This is an exhibit chunk whose exhibit could not be pinned down; neighbours may come from another exhibit in the same document.',
        );
      }
    }

    const inStream = (r: SearchResult): boolean =>
      r.metadata.documentId === documentId &&
      !!r.metadata.isExhibit === isExhibit &&
      (!isExhibit || !exhibitPath || r.metadata.exhibitPath === exhibitPath);

    // ---- 3. Boundary probes -------------------------------------------------
    // Run BEFORE the window, because they decide whether widening the search is
    // worth doing at all. "Fewer rows than asked for" is not proof of an edge:
    // `chunk_index` has real holes (68 of 35,786 consecutive pairs on the
    // measured index), so only an existence probe settles a boundary.
    const [prevProbe, nextProbe] = await Promise.all([
      store.scanTextColumn({
        filter: { documentId, _rawWhere: [...streamWhere, `chunk_index < ${targetIndex}`] },
        limit: 1,
      }) as Promise<SearchResult[]>,
      store.scanTextColumn({
        filter: { documentId, _rawWhere: [...streamWhere, `chunk_index > ${targetIndex}`] },
        limit: 1,
      }) as Promise<SearchResult[]>,
    ]);
    const atDocumentStart = !prevProbe.some(inStream);
    const atDocumentEnd = !nextProbe.some(inStream);

    // ---- 4. The window: adjacent ROWS, not adjacent indices -----------------
    // `chunk_index ± 1` is wrong. The index is not contiguous, so arithmetic
    // returns nothing across a hole while the neighbour sits just past it.
    // Instead: scan an index span, order the rows, take the nearest ones, and
    // widen the span if the side came up short while the probe says more
    // exists.
    //
    // The row cap is the subtle part. LanceDB has no ORDER BY, so a query that
    // hits its `limit` returns an ARBITRARY subset of the span — which may
    // exclude the true nearest neighbour and hand back a distant one with a
    // confidently wrong `indexGapFromPrevious`. So a capped result is never
    // trusted: a span that comes back full is a DENSE span, which means
    // neighbours are close, so the answer is to narrow rather than widen.
    let windowTruncated = false;
    let denseTruncation = false;
    // Set when two candidate rows inside the returned index range share an
    // index, so the row we picked as "the neighbour" was chosen by tiebreak.
    let sideDuplicateIndex = false;

    const MAX_SPAN = 4096;
    const ROW_CAP = 600;
    const limitFor = (s: number) => Math.min(s * 3 + 16, ROW_CAP);

    const collectSide = async (
      side: 'before' | 'after',
      need: number,
      moreExists: boolean,
    ): Promise<SearchResult[]> => {
      if (need <= 0 || !moreExists) return [];
      const minSpan = need * 2 + 2;
      let span = need * 8 + 8;
      for (let attempt = 0; attempt < 8; attempt++) {
        const bound =
          side === 'before'
            ? [`chunk_index >= ${targetIndex - span}`, `chunk_index < ${targetIndex}`]
            : [`chunk_index > ${targetIndex}`, `chunk_index <= ${targetIndex + span}`];
        const limit = limitFor(span);
        const rows: SearchResult[] = await store.scanTextColumn({
          filter: { documentId, _rawWhere: [...streamWhere, ...bound] },
          limit,
        });

        // A full page means the span was truncated at an arbitrary boundary.
        // Narrow towards the target instead of picking from an unordered slice.
        if (rows.length >= limit && span > minSpan) {
          span = Math.max(minSpan, Math.floor(span / 4));
          continue;
        }
        if (rows.length >= limit) denseTruncation = true;

        // Hard constraint 1, re-checked in JS: a store that ignores the filter
        // must still not be able to hand a foreign document's chunk to a caller.
        const kept = rows
          .filter(inStream)
          .filter((r) => r.chunkId !== target.chunkId)
          .filter((r) =>
            side === 'before'
              ? num(r.metadata.chunkIndex) < targetIndex
              : num(r.metadata.chunkIndex) > targetIndex,
          );
        const byId = new Map(kept.map((r) => [r.chunkId, r]));
        const sorted = [...byId.values()].sort(compareRows);
        const nearest =
          side === 'before' ? sorted.slice(-need) : sorted.slice(0, need);
        // Ambiguity check over the index range actually returned: a duplicate
        // there means the neighbour was picked by tiebreak, not by the index.
        if (nearest.length > 0) {
          const edge = num(
            (side === 'before' ? nearest[0] : nearest[nearest.length - 1]).metadata.chunkIndex,
          );
          const inRange = sorted.filter((r) =>
            side === 'before'
              ? num(r.metadata.chunkIndex) >= edge
              : num(r.metadata.chunkIndex) <= edge,
          );
          const seen = new Set<number>();
          for (const r of inRange) {
            const i = num(r.metadata.chunkIndex);
            if (seen.has(i)) sideDuplicateIndex = true;
            seen.add(i);
          }
        }
        if (nearest.length >= need) return nearest;
        if (span >= MAX_SPAN || attempt === 7) {
          windowTruncated = true;
          return nearest;
        }
        span = Math.min(span * 8, MAX_SPAN);
      }
      return [];
    };

    const [beforeRows, afterRows] = await Promise.all([
      collectSide('before', effectiveBefore, !atDocumentStart),
      collectSide('after', effectiveAfter, !atDocumentEnd),
    ]);

    const selected: Array<{ row: SearchResult; position: 'before' | 'target' | 'after' }> = [
      ...beforeRows.map((row) => ({ row, position: 'before' as const })),
      { row: target, position: 'target' as const },
      ...afterRows.map((row) => ({ row, position: 'after' as const })),
    ];

    // ---- 5. Ordering honesty ------------------------------------------------
    // A row sharing the target's own index is neither before nor after it. Those
    // exist: 4 documents on the measured index carry two generations of chunks
    // from a partial reindex, colliding on `chunk_index`.
    const twinRows: SearchResult[] = await store.scanTextColumn({
      filter: { documentId, _rawWhere: [...streamWhere, `chunk_index = ${targetIndex}`] },
      limit: 8,
    });
    const twins = twinRows.filter(inStream).filter((r) => r.chunkId !== target.chunkId);

    const indexCounts = new Map<number, number>();
    for (const { row } of selected) {
      const i = num(row.metadata.chunkIndex);
      indexCounts.set(i, (indexCounts.get(i) ?? 0) + 1);
    }
    const duplicateInWindow =
      [...indexCounts.values()].some((c) => c > 1) || sideDuplicateIndex;
    const orderingAmbiguous = duplicateInWindow || twins.length > 0;
    if (twins.length > 0) {
      notes.push(
        `${twins.length} other chunk(s) in this document share the target's chunk_index, so this document appears to hold more than one generation of chunks. Neighbour order here is not reliable.`,
      );
    } else if (duplicateInWindow) {
      notes.push(
        'More than one chunk in this window shares a chunk_index, so neighbour order is not fully determined by the stored index.',
      );
    }

    if (atDocumentStart) {
      notes.push(
        'No preceding chunk: the target is the first chunk of this document. Nothing before it exists to return.',
      );
    } else if (effectiveBefore > 0 && beforeRows.length < effectiveBefore) {
      notes.push(
        `Only ${beforeRows.length} of ${effectiveBefore} preceding chunks could be retrieved for this document.`,
      );
    }
    if (atDocumentEnd) {
      notes.push(
        'No following chunk: the target is the last chunk of this document. Nothing after it exists to return.',
      );
    } else if (effectiveAfter > 0 && afterRows.length < effectiveAfter) {
      notes.push(
        `Only ${afterRows.length} of ${effectiveAfter} following chunks could be retrieved for this document.`,
      );
    }
    if (windowTruncated) {
      notes.push(
        'The search for neighbours was bounded and did not reach as far as requested; more chunks exist in this document beyond what was returned.',
      );
    }
    if (denseTruncation) {
      notes.push(
        'This region of the document holds an unusually large number of chunks at nearby indices, so the neighbours returned may not be the closest ones.',
      );
    }

    // ---- 5. Enrichment: one document, one citation context, one motion pass --
    let document: any = null;
    try {
      document = await (context.database as any)?.document?.findUnique({
        where: { id: documentId },
        select: { fileName: true, filing: true, case: true, documentType: true, tags: true },
      });
    } catch {
      // A document row we cannot read is not worth failing a lookup over.
    }

    const caseId: string | undefined =
      target.metadata.caseId || document?.case?.id || undefined;
    const caseCtx: CaseCitationContext = caseId
      ? (await buildCaseCitationContexts([caseId], context.database)).get(caseId) ??
        defaultCitationContext()
      : defaultCitationContext();

    const filingId: string | undefined = document?.filing?.id;
    const docFilingIds = new Map<string, string>();
    if (filingId) docFilingIds.set(documentId, filingId);

    const chunks: ChunkContextEntry[] = selected.map(({ row, position }) => {
      const m = row.metadata;
      const filingType =
        m.filingType || document?.filing?.filingType || document?.documentType || undefined;
      let volumeNumber: number | undefined = m.volumeNumber || document?.filing?.volumeNumber;
      if (!volumeNumber && document?.fileName) {
        const volMatch = String(document.fileName).match(/-VOL(\d+)/i);
        if (volMatch) volumeNumber = parseInt(volMatch[1], 10);
      }
      const caseNumber = m.caseNumber || document?.case?.caseNumber || caseCtx.caseNumber;

      const citationInput: CitationInput = {
        filingType,
        volumeNumber,
        totalVolumes: filingType ? (caseCtx.volumeCountMap.get(filingType) ?? 1) : 1,
        caseNumber: caseNumber || undefined,
        pageNumber: num(m.pageNumber),
        fileName: document?.fileName,
        isSupplemental: document?.filing?.isSupplemental || false,
        supplementalOrder: document?.filing?.supplementalOrder || undefined,
      };
      if (filingType) {
        const ft = filingType.toLowerCase();
        if (ft.includes('reporter') || ft === 'rr') {
          if (m.startLine && m.endLine) {
            citationInput.lineStart = num(m.startLine);
            citationInput.lineEnd = num(m.endLine);
          } else {
            const lineRange = detectLineNumbers(row.text);
            citationInput.lineStart = lineRange.startLine;
            citationInput.lineEnd = lineRange.endLine;
          }
        }
      }
      const formatted = caseCtx.formatter.format(citationInput);

      // Draft guard: the chunk's own stamp first, then the Document tag for
      // rows indexed before the column existed. Every chunk is judged on its
      // own status — a filed target does not clear a draft neighbour.
      const tagStatus = recordStatusFromTags(document?.tags);
      const recordStatus =
        m.recordStatus ?? (tagStatus === 'unknown' ? undefined : tagStatus);
      const draftSuffix = recordStatus === 'draft' ? ` — ${DRAFT_CITE_MARKER}` : '';

      return {
        // Spread rather than re-listed, so a new provenance field cannot be
        // dropped at this projection (draft-record-guard invariant 3). Listed
        // first so the explicit fields below win on the keys they share.
        ...pickProvenance({ ...m, documentId, caseId: m.caseId || caseId, recordStatus }),
        chunkId: row.chunkId,
        text: row.text,
        page: num(m.pageNumber),
        chunkIndex: num(m.chunkIndex),
        documentId,
        isTarget: position === 'target',
        position,
        citation: formatted.full + draftSuffix,
        citationShort: formatted.short + draftSuffix,
        filingType,
        volumeNumber,
        caseNumber: caseNumber || undefined,
        motionId: undefined as string | undefined,
        filingSlug: document?.filing?.slug || undefined,
        isExhibit: !!m.isExhibit,
        startLine: m.startLine === undefined ? undefined : num(m.startLine),
        endLine: m.endLine === undefined ? undefined : num(m.endLine),
      };
    });

    // Adjacency of the RETURNED rows. These are neighbouring rows by
    // construction; whether their indices are consecutive is a separate
    // question, and a caller assembling text across them needs the answer.
    let contiguous = true;
    for (let i = 1; i < chunks.length; i++) {
      const gap = chunks[i].chunkIndex - chunks[i - 1].chunkIndex;
      if (gap !== 1) {
        chunks[i].indexGapFromPrevious = gap;
        contiguous = false;
      }
    }
    if (!contiguous) {
      notes.push(
        'The returned chunks are neighbouring rows in the index, but their chunk_index values are not consecutive (see indexGapFromPrevious). Text may be missing between them, so do not present them as one uninterrupted passage.',
      );
    }

    try {
      await attachMotionIds(context, chunks as any, docFilingIds);
    } catch {
      // Motion enrichment is best-effort — never fail a context read over it.
    }

    const containsDraft = chunks.some((c) => c.recordStatus === 'draft');
    if (containsDraft) {
      notes.push(
        'At least one chunk in this window is from a DRAFT (unfiled working copy). Do not merge its text into a quotation presented as the filed record; cite it as "draft (filing not confirmed)".',
      );
    }

    return {
      document: document?.fileName || 'Unknown',
      documentId,
      caseId,
      chunks,
      requestedBefore,
      requestedAfter,
      effectiveBefore,
      effectiveAfter,
      maxContext: MAX_CONTEXT,
      returnedBefore: chunks.filter((c) => c.position === 'before').length,
      returnedAfter: chunks.filter((c) => c.position === 'after').length,
      atDocumentStart,
      atDocumentEnd,
      contiguous,
      containsDraft,
      orderingAmbiguous,
      notes,
      ordering: ORDERING_NOTE,
    };
  }
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_CONTEXT, Math.floor(n)));
}
