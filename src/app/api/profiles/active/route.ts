/**
 * GET  /api/profiles/active   — { active, legacy }
 * POST /api/profiles/active   — { name } → switch the whole server to that profile
 *
 * The switch is global (design A): dashboard, MCP and every API read the new
 * profile from the moment it returns. Services bound to the old profile are
 * restarted; the response says which.
 */
import { NextRequest, NextResponse } from 'next/server';
import { activeProfileName, profilesEnabled, readManifest } from '@/lib/profiles';
import { switchProfile } from '@/lib/profiles/switch';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ active: activeProfileName(), legacy: !profilesEnabled() });
}

export async function POST(req: NextRequest) {
  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: 'JSON body required' } }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || !readManifest(name)) {
    return NextResponse.json({ error: { message: `profile not found: ${name || '(empty)'}` } }, { status: 404 });
  }
  try {
    const result = await switchProfile(name);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: { message: err instanceof Error ? err.message : 'switch failed' } }, { status: 500 });
  }
}
