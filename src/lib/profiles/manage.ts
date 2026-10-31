/**
 * Update and delete for profiles (docs/tasks/54-profiles.md).
 *
 * Rules, all enforced here so the API and any future MCP tool agree:
 *   - display name and description change freely, active or not;
 *   - the directory name (the identity) changes only for a NON-active profile,
 *     because every open handle in the process is keyed by it;
 *   - display names are unique (case-insensitive) — 409 on a clash;
 *   - delete only a NON-active profile, never the last one, never the
 *     adopted default (its data lives outside its folder);
 *   - delete moves the directory to `data/.trash/<name>-<timestamp>` rather
 *     than removing it. A profile is gigabytes of litigation data; the trash
 *     is the undo. The operator empties it by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  activeProfileName,
  dataRoot,
  displayNameTaken,
  forgetProfileStorageCache,
  isValidProfileName,
  listProfiles,
  profilePaths,
  readManifest,
  writeManifestFile,
  type ProfileManifest,
} from './registry';

export interface UpdateProfileInput {
  displayName?: string;
  description?: string | null;
  /** Rename the directory (the profile's identity). Non-active profiles only. */
  newName?: string;
}

const writeManifest = writeManifestFile;

export function updateProfile(name: string, input: UpdateProfileInput): ProfileManifest {
  const current = readManifest(name);
  if (!current) throw new Error(`profile not found: ${name}`);

  const next: ProfileManifest = { ...current };
  if (input.displayName !== undefined) {
    const dn = input.displayName.trim();
    if (!dn) throw new Error('displayName cannot be empty');
    const clash = displayNameTaken(dn, name);
    if (clash) throw new Error(`profile already exists with the name "${clash.displayName}"`);
    next.displayName = dn.slice(0, 80);
  }
  if (input.description !== undefined) {
    const d = (input.description ?? '').trim();
    if (d) next.description = d.slice(0, 400);
    else delete next.description;
  }
  // Check the folder rename BEFORE writing anything, so a refused rename
  // does not half-apply the display name.
  const newName = input.newName?.trim().toLowerCase();
  const renaming = !!newName && newName !== name;
  if (renaming) {
    if (!isValidProfileName(newName)) throw new Error(`invalid profile name: ${newName} (lowercase letters, digits, - and _, max 40)`);
    if (readManifest(newName)) throw new Error(`profile already exists: ${newName}`);
    if (fs.existsSync(path.join(dataRoot(), newName))) throw new Error(`invalid profile name: ${newName} (a data folder with that name already exists)`);
    if (activeProfileName() === name) throw new Error('cannot rename the active profile folder — switch to another profile first (the display name can change)');
  }
  writeManifest(name, next);

  if (renaming) {
    fs.renameSync(profilePaths(name).root, profilePaths(newName).root);
    forgetProfileStorageCache();
    writeManifest(newName, { ...next, name: newName });
    return readManifest(newName)!;
  }
  return readManifest(name)!;
}

export interface DeleteProfileResult {
  name: string;
  trashedTo: string;
}

export function deleteProfile(name: string): DeleteProfileResult {
  if (!readManifest(name)) throw new Error(`profile not found: ${name}`);
  if (activeProfileName() === name) throw new Error('cannot delete the active profile — switch to another profile first');
  if (listProfiles().length <= 1) throw new Error('cannot delete the last profile');
  // The adopted profile's data lives outside its folder (lib/profiles/adopt.ts);
  // trashing the folder would orphan it, not delete it.
  if (readManifest(name)?.storage) throw new Error('cannot delete the default profile: its data lives outside data/<name>/');

  const trashRoot = path.join(dataRoot(), '.trash');
  fs.mkdirSync(trashRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashedTo = path.join(trashRoot, `${name}-${stamp}`);
  fs.renameSync(profilePaths(name).root, trashedTo);
  forgetProfileStorageCache();
  return { name, trashedTo };
}
