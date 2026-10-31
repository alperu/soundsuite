/**
 * Turn the pre-profiles ("legacy") data into a real profile IN PLACE.
 *
 * A server that never ran `scripts/profiles-migrate.mjs` (every Docker
 * install: the DB lives at `/data/v1/db/sound-suite.db`, not under
 * `data/<name>/`) has no `profile.json`, so it runs on the synthetic
 * `legacy` profile. That profile cannot be renamed and no second profile can
 * be added next to it, because nothing on disk describes it.
 *
 * Adoption writes `data/<name>/profile.json` whose `storage` block points at
 * the files the server already uses. No file moves, no copy, no restart: the
 * same SQLite file and LanceDB directory stay open under a new profile name.
 * It runs once, on the first profile write (rename or create), and is a no-op
 * when any profile already exists.
 */
import fs from 'node:fs';
import {
  LEGACY_PROFILE,
  activeProfileName,
  forgetProfileStorageCache,
  legacyPaths,
  listProfiles,
  readManifest,
  resetActiveProfileCache,
  setActiveProfileName,
  writeManifestFile,
  type ProfileManifest,
} from './registry';
import { profilePaths } from './registry';

/** Folder name the adopted data gets. Display name is free to change later. */
export const ADOPTED_PROFILE = 'default';
export const ADOPTED_DISPLAY_NAME = 'Default';

export interface AdoptResult {
  adopted: boolean;
  name: string;
}

/**
 * Adopt the legacy data as profile `default` when no profile exists yet.
 * Returns the name the caller should now use in place of `legacy`.
 */
export async function adoptLegacyIfNeeded(): Promise<AdoptResult> {
  if (listProfiles().length > 0) return { adopted: false, name: activeProfileName() };

  const legacy = legacyPaths();
  const root = profilePaths(ADOPTED_PROFILE).root;
  fs.mkdirSync(root, { recursive: true });
  const manifest: ProfileManifest = {
    name: ADOPTED_PROFILE,
    displayName: ADOPTED_DISPLAY_NAME,
    createdAt: new Date().toISOString(),
    description: 'existing data, adopted in place',
    storage: {
      sqlite: legacy.sqlite,
      lancedb: legacy.lancedb,
      chat: legacy.chat,
      chatAttachments: legacy.chatAttachments,
      ocrCaptures: legacy.ocrCaptures,
      backups: legacy.backups,
    },
  };
  writeManifestFile(ADOPTED_PROFILE, manifest);
  forgetProfileStorageCache();
  resetActiveProfileCache();
  setActiveProfileName(ADOPTED_PROFILE);

  // The clients cached under the name `legacy` point at the same files; drop
  // them so only the `default` entry holds the database open.
  try {
    const { releasePrismaClient } = await import('@/lib/db/prisma');
    await releasePrismaClient(LEGACY_PROFILE);
  } catch {
    /* nothing cached */
  }
  try {
    const { releaseKysely } = await import('@/lib/legal/kysely');
    releaseKysely(LEGACY_PROFILE);
  } catch {
    /* nothing cached */
  }
  return { adopted: true, name: ADOPTED_PROFILE };
}

/** The adopted profile owns data outside its folder; it cannot be deleted. */
export function isAdoptedProfile(name: string): boolean {
  return !!readManifest(name)?.storage;
}
