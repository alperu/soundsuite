import { NextResponse } from 'next/server';

/**
 * Reserved native MCP path for the `routed` profile (REPORT-v2.1 Part E.1).
 * 404s until the Streamable HTTP transport lands; today clients register the
 * stdio bridge with SOUND_SUITE_PROFILE=routed instead.
 */

function notAvailable() {
  return NextResponse.json(
    {
      error: {
        code: 'NOT_AVAILABLE',
        message: 'Native MCP transport not yet available; register the stdio bridge with SOUND_SUITE_PROFILE=routed',
      },
    },
    { status: 404 },
  );
}

export async function GET() { return notAvailable(); }
export async function POST() { return notAvailable(); }
export async function PUT() { return notAvailable(); }
export async function PATCH() { return notAvailable(); }
export async function DELETE() { return notAvailable(); }
export async function HEAD() { return notAvailable(); }
export async function OPTIONS() { return notAvailable(); }
