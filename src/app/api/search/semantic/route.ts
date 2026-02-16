import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('query');
    const caseId = searchParams.get('caseId');

    if (!query) {
      return NextResponse.json(
        { error: { message: 'Query parameter is required' } },
        { status: 400 }
      );
    }

    const registry = await getToolRegistry();
    const result = await registry.execute('query_case_knowledge', {
      query,
      ...(caseId && { caseId }),
      limit: 10,
    });

    if (!result.success) {
      const errorMsg = result.error ?? 'Search failed';
      const isDimMismatch = errorMsg.includes('dimension mismatch') || errorMsg.includes('query dim');
      const isEmbedError = errorMsg.includes("Cannot read properties of null") && errorMsg.includes("embed");
      return NextResponse.json(
        {
          error: {
            message: isDimMismatch
              ? 'Embedding model changed since documents were indexed. Please reindex from Admin > Embedding Config.'
              : isEmbedError
              ? 'Embedding provider is not configured. Check Admin > Embedding Config.'
              : errorMsg,
          },
        },
        { status: 500 }
      );
    }

    return NextResponse.json(result.data);
  } catch (error) {
    console.error('Semantic search error:', error);
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Internal server error'
        }
      },
      { status: 500 }
    );
  }
}
