import { NextRequest, NextResponse } from 'next/server';
import { fetchPendingCommands } from '@/lib/gpu/command-queue';

/**
 * POST /api/admin/gpu/sidecars/poll
 * Sidecar polls for pending commands.
 * Body: { agentUrl: string }
 * Returns: { commands: [{ id, action, payload }] }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { agentUrl } = body;

    if (!agentUrl || typeof agentUrl !== 'string') {
      return NextResponse.json({ error: 'agentUrl is required' }, { status: 400 });
    }

    const commands = await fetchPendingCommands(agentUrl);
    return NextResponse.json({ commands });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
