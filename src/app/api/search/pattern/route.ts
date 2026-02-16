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
    const result = await registry.execute('scan_for_pattern', {
      pattern: query,
      ...(caseId && { caseId }),
      limit: 50,
    });

    if (!result.success) {
      const errorMsg = result.error ?? 'Pattern search failed';
      const isInvalidRegex = errorMsg.includes('Invalid regex') || errorMsg.includes('INVALID_REGEX');
      return NextResponse.json(
        {
          error: {
            message: isInvalidRegex
              ? 'Invalid regex pattern. Please check your search syntax.'
              : errorMsg,
          },
        },
        { status: isInvalidRegex ? 400 : 500 }
      );
    }

    return NextResponse.json(result.data);
  } catch (error) {
    console.error('Pattern search error:', error);
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
