import { NextRequest, NextResponse } from 'next/server';
import { getWorkflow, updateWorkflow, deleteWorkflow, addCitations } from '@/services/workflow-service';

/**
 * GET /api/workflows/[id]
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workflow = await getWorkflow(id);
    if (!workflow) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
    }
    return NextResponse.json({ workflow });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get workflow' },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/workflows/[id]
 * Update workflow content, title, status, or add citations.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();

    // If citations array is provided, append them
    if (body.citations && Array.isArray(body.citations)) {
      const workflow = await addCitations(id, body.citations);
      return NextResponse.json({ workflow });
    }

    // Otherwise update fields
    const { title, content, status } = body;
    const workflow = await updateWorkflow(id, { title, content, status });
    return NextResponse.json({ workflow });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update workflow' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/workflows/[id]
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await deleteWorkflow(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete workflow' },
      { status: 500 },
    );
  }
}
