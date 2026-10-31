/**
 * GET    /api/profiles/[name]  — manifest + paths + cases
 * PATCH  /api/profiles/[name]  — { displayName?, description?, newName? }
 * DELETE /api/profiles/[name]  — move the profile directory to data/.trash/
 *
 * The display name of ANY profile can change, the active one included. The
 * folder name changes only for a non-active profile; delete refuses the
 * active profile, the last one and the adopted default. See
 * lib/profiles/manage.ts.
 *
 * `legacy` (pre-profiles data) is adopted as profile `default` on the first
 * PATCH, so "rename Default" works on a server that never migrated.
 *
 * GET: loopback, API key or a dashboard session. PATCH/DELETE: admin role.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireApiAccess } from '@/lib/api/route-guard';
import { LEGACY_PROFILE, profilePaths, readManifest } from '@/lib/profiles';
import { adoptLegacyIfNeeded } from '@/lib/profiles/adopt';
import { profileErrorStatus } from '@/lib/profiles/errors';
import { deleteProfile, updateProfile } from '@/lib/profiles/manage';
import { listProfilesWithCases } from '@/lib/profiles/service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ name: string }> | { name: string } };

export async function GET(req: NextRequest, ctx: Ctx) {
  const denied = await requireApiAccess(req, { label: 'profile GET', allowAdminSession: true });
  if (denied) return denied;
  const { name } = await ctx.params;
  const manifest = readManifest(name);
  if (!manifest) return NextResponse.json({ error: { message: `profile not found: ${name}` } }, { status: 404 });
  const listing = await listProfilesWithCases({ includeCases: true });
  const view = listing.profiles.find((p) => p.name === name);
  return NextResponse.json({ ...manifest, active: view?.active ?? false, cases: view?.cases ?? [], paths: profilePaths(name) });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const denied = await requireApiAccess(req, { label: 'profile PATCH', allowAdminSession: true, requireAdminRole: true });
  if (denied) return denied;
  let { name } = await ctx.params;
  let body: { displayName?: unknown; description?: unknown; newName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: 'JSON body required' } }, { status: 400 });
  }
  try {
    if (name === LEGACY_PROFILE) {
      const adopted = await adoptLegacyIfNeeded();
      if (!adopted.adopted && !readManifest(adopted.name)) {
        return NextResponse.json({ error: { message: `profile not found: ${name}` } }, { status: 404 });
      }
      name = adopted.name;
    }
    const manifest = updateProfile(name, {
      ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      ...(body.description === null || typeof body.description === 'string' ? { description: body.description as string | null } : {}),
      ...(typeof body.newName === 'string' ? { newName: body.newName } : {}),
    });
    return NextResponse.json({ profile: manifest });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'update failed';
    return NextResponse.json({ error: { message } }, { status: profileErrorStatus(message) });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const denied = await requireApiAccess(req, { label: 'profile DELETE', allowAdminSession: true, requireAdminRole: true });
  if (denied) return denied;
  const { name } = await ctx.params;
  try {
    return NextResponse.json(deleteProfile(name));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'delete failed';
    return NextResponse.json({ error: { message } }, { status: profileErrorStatus(message) });
  }
}
