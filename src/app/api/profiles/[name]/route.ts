/**
 * GET    /api/profiles/[name]  — manifest + paths + cases
 * PATCH  /api/profiles/[name]  — { displayName?, description?, newName? }
 * DELETE /api/profiles/[name]  — move the profile directory to data/.trash/
 *
 * Rename and delete refuse the ACTIVE profile (switch first) and delete
 * refuses the last profile. See lib/profiles/manage.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { profilePaths, readManifest } from '@/lib/profiles';
import { deleteProfile, updateProfile } from '@/lib/profiles/manage';
import { listProfilesWithCases } from '@/lib/profiles/service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ name: string }> | { name: string } };

function statusFor(message: string): number {
  if (/not found/.test(message)) return 404;
  if (/already exists|active profile|last profile/.test(message)) return 409;
  if (/invalid|cannot be empty/.test(message)) return 400;
  return 500;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  const manifest = readManifest(name);
  if (!manifest) return NextResponse.json({ error: { message: `profile not found: ${name}` } }, { status: 404 });
  const listing = await listProfilesWithCases({ includeCases: true });
  const view = listing.profiles.find((p) => p.name === name);
  return NextResponse.json({ ...manifest, active: view?.active ?? false, cases: view?.cases ?? [], paths: profilePaths(name) });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  let body: { displayName?: unknown; description?: unknown; newName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: 'JSON body required' } }, { status: 400 });
  }
  try {
    const manifest = updateProfile(name, {
      ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      ...(body.description === null || typeof body.description === 'string' ? { description: body.description as string | null } : {}),
      ...(typeof body.newName === 'string' ? { newName: body.newName } : {}),
    });
    return NextResponse.json({ profile: manifest });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'update failed';
    return NextResponse.json({ error: { message } }, { status: statusFor(message) });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  try {
    return NextResponse.json(deleteProfile(name));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'delete failed';
    return NextResponse.json({ error: { message } }, { status: statusFor(message) });
  }
}
