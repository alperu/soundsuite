export {
  LEGACY_PROFILE,
  PROFILE_NAME_RE,
  activeProfile,
  activeProfileName,
  dataRoot,
  isValidProfileName,
  legacyPaths,
  listProfiles,
  profilePaths,
  profilesEnabled,
  readManifest,
  readRegistry,
  resetActiveProfileCache,
  scaffoldProfile,
  setActiveProfileName,
} from './registry';
export type { ProfileManifest, ProfilePaths } from './registry';

import { activeProfile as active } from './registry';

/** The active profile's LanceDB directory — replaces `process.env.LANCEDB_PATH || './data/lancedb'`. */
export function lancedbPath(): string {
  return active().lancedb;
}

/** The active profile's SQLite file. */
export function sqlitePath(): string {
  return active().sqlite;
}
