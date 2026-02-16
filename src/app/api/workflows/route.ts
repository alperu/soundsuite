import { NextRequest, NextResponse } from 'next/server';
import { listWorkflows, createWorkflow } from '@/services/workflow-service';

/**
 * GET /api/workflows?caseId=...
 * List workflows for a case.
 */
export async function GET(request: NextRequest) {
  try {
    const caseId = request.nextUrl.searchParams.get('caseId');
    if (!caseId) {
      return NextResponse.json({ error: 'caseId is required' }, { status: 400 });
    }
    const workflows = await listWorkflows(caseId);
    return NextResponse.json({ workflows });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list workflows' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/workflows
 * Create a workflow (optionally from a template).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { caseId, templateId, title } = body;

    if (!caseId || !title) {
      return NextResponse.json({ error: 'caseId and title are required' }, { status: 400 });
    }

    const workflow = await createWorkflow({ caseId, templateId, title });
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create workflow' },
      { status: 500 },
    );
  }
}
