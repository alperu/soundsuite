/**
 * The profile listing every surface shows — dashboard dropdown, the
 * `/api/profiles` route and the `profile_list` MCP tool — built once here so
 * they cannot disagree about what a profile is or which one is active.
 *
 * Cases for the ACTIVE profile come through Prisma (the same rows the
 * dashboard lists); cases for the others are read straight from their SQLite
 * file, read-only. A profile that has no database yet lists no cases.
 */
import { prisma } from '@/lib/db/prisma';
import { peekCases } from './create';
import { activeProfileName, listProfiles, profilePaths, LEGACY_PROFILE, type ProfileManifest } from './registry';

export interface ProfileCaseSummary {
  id: string;
  name: string;
  caseNumber: string | null;
  documents: number;
}

export interface ProfileView extends ProfileManifest {
  active: boolean;
  root: string;
  cases: ProfileCaseSummary[];
}

export interface ProfilesListing {
  active: string;
  /** True when no profile directory exists yet and the process runs on the
   *  pre-profiles layout (`DATABASE_URL`, `data/lancedb`). */
  legacy: boolean;
  profiles: ProfileView[];
}

async function activeCases(): Promise<ProfileCaseSummary[]> {
  const rows = await prisma.case.findMany({
    select: { id: true, name: true, caseNumber: true, _count: { select: { documents: true } } },
    orderBy: { name: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, caseNumber: r.caseNumber ?? null, documents: r._count.documents }));
}

export async function listProfilesWithCases(opts: { includeCases?: boolean } = {}): Promise<ProfilesListing> {
  const active = activeProfileName();
  const manifests = listProfiles();
  const includeCases = opts.includeCases !== false;

  if (manifests.length === 0) {
    return {
      active: LEGACY_PROFILE,
      legacy: true,
      profiles: [
        {
          name: LEGACY_PROFILE,
          displayName: 'Default (pre-profiles layout)',
          createdAt: '',
          active: true,
          root: profilePaths(LEGACY_PROFILE).root,
          cases: includeCases ? await activeCases() : [],
        },
      ],
    };
  }

  const profiles: ProfileView[] = [];
  for (const m of manifests) {
    const isActive = m.name === active;
    let cases: ProfileCaseSummary[] = [];
    if (includeCases) {
      try {
        cases = isActive ? await activeCases() : peekCases(m.name);
      } catch {
        cases = [];
      }
    }
    profiles.push({ ...m, active: isActive, root: profilePaths(m.name).root, cases });
  }
  return { active, legacy: false, profiles };
}
