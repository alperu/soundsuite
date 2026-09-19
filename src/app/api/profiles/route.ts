/**
 * GET  /api/profiles          — every profile, which is active, cases in each
 * POST /api/profiles          — create one: { name, displayName?, description?, copySettingsFrom? }
 *
 * Profiles are Chrome-style: one active per process, discovered from
 * `data/<name>/profile.json`. See docs/tasks/54-profiles.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listProfilesWithCases } from '@/lib/profiles/service';
import { createProfile } from '@/lib/profiles/create';
import { isValidProfileName } from '@/lib/profiles';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const includeCases = req.nextUrl.searchParams.get('cases') !== '0';
    return NextResponse.json(await listProfilesWithCases({ includeCases }));
  } catch (err) {
    return NextResponse.json({ error: { message: err instanceof Error ? err.message : 'failed to list profiles' } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { name?: unknown; displayName?: unknown; description?: unknown; copySettingsFrom?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: 'JSON body required' } }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  if (!isValidProfileName(name)) {
    return NextResponse.json(
      { error: { message: 'name must be lowercase letters, digits, - or _ (max 40) and not "legacy"' } },
      { status: 400 },
    );
  }
  try {
    const created = await createProfile({
      name,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      copySettingsFrom: typeof body.copySettingsFrom === 'string' && body.copySettingsFrom ? body.copySettingsFrom : undefined,
    });
    return NextResponse.json({ profile: created.manifest, root: created.paths.root, copiedSettings: created.copiedSettings }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to create profile';
    return NextResponse.json({ error: { message } }, { status: /already exists|not found/.test(message) ? 409 : 500 });
  }
}
