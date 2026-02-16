import { NextRequest, NextResponse } from 'next/server';
import { getTemplate, updateTemplate, deleteTemplate } from '@/services/workflow-service';

/**
 * PATCH /api/workflow-templates/[id]
 * Update a workflow template.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, jurisdiction, category, tags, description, content } = body;

    const template = await updateTemplate(id, {
      name, jurisdiction, category, tags, description, content,
    });
    return NextResponse.json({ template });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update template' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/workflow-templates/[id]
 * Delete a workflow template.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await deleteTemplate(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete template' },
      { status: 500 },
    );
  }
}
