import { NextResponse } from 'next/server';
import { getAllCategories } from '@/services/workflow-service';

/**
 * GET /api/workflow-templates/categories
 * Returns all unique categories across templates.
 */
export async function GET() {
  try {
    const categories = await getAllCategories();
    return NextResponse.json({ categories });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get categories' },
      { status: 500 },
    );
  }
}
