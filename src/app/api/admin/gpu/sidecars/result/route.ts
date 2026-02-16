import { NextRequest, NextResponse } from 'next/server';
import { reportCommandResult } from '@/lib/gpu/command-queue';

/**
 * POST /api/admin/gpu/sidecars/result
 * Sidecar reports a command execution result.
 * Body: { commandId: string, result?: object, error?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { commandId, result, error } = body;

    if (!commandId || typeof commandId !== 'string') {
      return NextResponse.json({ error: 'commandId is required' }, { status: 400 });
    }

    const resolved = await reportCommandResult(commandId, result, error);
    return NextResponse.json({ ok: true, resolved });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
