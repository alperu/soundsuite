import { NextRequest, NextResponse } from 'next/server';
import { listTemplates, createTemplate, seedDefaultTemplates } from '@/services/workflow-service';

/**
 * GET /api/workflow-templates
 * List all workflow templates. Seeds defaults on first call.
 * Supports query params: ?category=...&tag=...&search=...
 */
export async function GET(request: NextRequest) {
  try {
    // Ensure default templates exist
    await seedDefaultTemplates();

    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category') || undefined;
    const tag = searchParams.get('tag') || undefined;
    const search = searchParams.get('search') || undefined;

    const templates = await listTemplates({ category, tag, search });
    return NextResponse.json({ templates });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list templates' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/workflow-templates
 * Create a new workflow template.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, jurisdiction, category, tags, description, content } = body;

    if (!name || !content) {
      return NextResponse.json({ error: 'name and content are required' }, { status: 400 });
    }

    const template = await createTemplate({ name, jurisdiction, category, tags, description, content });
    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create template' },
      { status: 500 },
    );
  }
}
