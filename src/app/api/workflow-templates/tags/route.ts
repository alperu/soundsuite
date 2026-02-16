import { NextResponse } from 'next/server';
import { getAllTags } from '@/services/workflow-service';

/**
 * GET /api/workflow-templates/tags
 * Returns all unique tags across templates.
 */
export async function GET() {
  try {
    const tags = await getAllTags();
    return NextResponse.json({ tags });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get tags' },
      { status: 500 },
    );
  }
}
