/**
 * Unified search endpoint (Task #54).
 *
 * Single entry point that supersedes:
 *   - /api/search/haystack  (now a deprecated forwarder; this is its canonical replacement)
 *   - The `mode: 'legacy' | 'boolean'` split on /api/search/ai
 *
 * Behaviour:
 *   - POST { query: string, caseId?: string, chatId?: string, limit?: number,
 *            searchMode?: 'vector'|'hybrid'|'keyword' }
 *   - Parses `query` as Axon-flavored boolean (see boolean-query.ts).
 *   - Walks the AST: lifts lance-scalar / lance-scalar-ref into a SQL pre-filter,
 *     resolves prisma-traverse requests via the legal schema, leaves the rest
 *     as an FTS body. The semantic arm embeds the full original query.
 *   - Returns { chunks, total } in a single envelope.
 *
 * This route does NOT handle LLM generation — that path is /api/search/ai's
 * job (RAG stream). The unified route is the retrieval substrate that the
 * RAG path will be migrated to call next iteration.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

interface UnifiedSearchBody {
  query: string;
  caseId?: string;
  chatId?: string;
  limit?: number;
  searchMode?: 'vector' | 'hybrid' | 'keyword';
}

export async function POST(request: NextRequest) {
  let body: UnifiedSearchBody;
  try {
    body = (await request.json()) as UnifiedSearchBody;
  } catch {
    return NextResponse.json(
      { error: { message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const query = (body.query ?? '').trim();
  if (!query) {
    return NextResponse.json(
      { error: { message: 'query is required' } },
      { status: 400 },
    );
  }
  const limit = body.limit ?? 20;
  const searchMode = body.searchMode ?? 'hybrid';

  try {
    // The unified pipeline lives inside query_case_knowledge — it owns the
    // AST → field-filter extraction → prisma-traverse resolution → LanceDB
    // pre-filter flow. We always run it in `boolean` mode now; the legacy
    // keyword-only path is removed.
    const registry = await getToolRegistry();
    const result = await registry.execute('query_case_knowledge', {
      query,
      ...(body.caseId ? { caseId: body.caseId } : {}),
      ...(body.chatId ? { chatId: body.chatId } : {}),
      limit,
      searchMode,
      mode: 'boolean',
    });

    if (!result.success) {
      const msg = result.error ?? 'Search failed';
      const isDimMismatch = msg.includes('dimension mismatch') || msg.includes('query dim');
      const isEmbedError = msg.includes('Cannot read properties of null') && msg.includes('embed');
      return NextResponse.json(
        {
          error: {
            message: isDimMismatch
              ? 'Embedding model changed since documents were indexed. Please reindex from Admin > Embedding Config.'
              : isEmbedError
              ? 'Embedding provider is not configured. Check Admin > Embedding Config.'
              : msg,
          },
        },
        { status: 500 },
      );
    }

    const chunks = (result.data as any)?.results ?? [];
    return NextResponse.json({
      query,
      chunks,
      total: chunks.length,
    });
  } catch (err) {
    console.error('[unified search] error', err);
    return NextResponse.json(
      { error: { message: err instanceof Error ? err.message : 'Unified search failed' } },
      { status: 500 },
    );
  }
}
