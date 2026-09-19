/**
 * Update and delete for profiles (docs/tasks/54-profiles.md).
 *
 * Rules, all enforced here so the API and any future MCP tool agree:
 *   - display name and description change freely, active or not;
 *   - the directory name (the identity) changes only for a NON-active profile,
 *     because every open handle in the process is keyed by it;
 *   - delete only a NON-active profile, and never the last one;
 *   - delete moves the directory to `data/.trash/<name>-<timestamp>` rather
 *     than removing it. A profile is gigabytes of litigation data; the trash
 *     is the undo. The operator empties it by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PROFILE_FILE,
  activeProfileName,
  dataRoot,
  isValidProfileName,
  listProfiles,
  profilePaths,
  readManifest,
  type ProfileManifest,
} from './registry';

export interface UpdateProfileInput {
  displayName?: string;
  description?: string | null;
  /** Rename the directory (the profile's identity). Non-active profiles only. */
  newName?: string;
}

function writeManifest(name: string, manifest: ProfileManifest): void {
  const file = path.join(dataRoot(), name, PROFILE_FILE);
  const { name: _n, ...rest } = manifest;
  fs.writeFileSync(file, JSON.stringify({ ...rest, name }, null, 2) + '\n');
}

export function updateProfile(name: string, input: UpdateProfileInput): ProfileManifest {
  const current = readManifest(name);
  if (!current) throw new Error(`profile not found: ${name}`);

  const next: ProfileManifest = { ...current };
  if (input.displayName !== undefined) {
    const dn = input.displayName.trim();
    if (!dn) throw new Error('displayName cannot be empty');
    next.displayName = dn.slice(0, 80);
  }
  if (input.description !== undefined) {
    const d = (input.description ?? '').trim();
    if (d) next.description = d.slice(0, 400);
    else delete next.description;
  }
  writeManifest(name, next);

  const newName = input.newName?.trim().toLowerCase();
  if (newName && newName !== name) {
    if (!isValidProfileName(newName)) throw new Error(`invalid profile name: ${newName} (lowercase letters, digits, - and _, max 40)`);
    if (readManifest(newName)) throw new Error(`profile already exists: ${newName}`);
    if (activeProfileName() === name) throw new Error('cannot rename the active profile — switch to another profile first');
    fs.renameSync(profilePaths(name).root, profilePaths(newName).root);
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

  const trashRoot = path.join(dataRoot(), '.trash');
  fs.mkdirSync(trashRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashedTo = path.join(trashRoot, `${name}-${stamp}`);
  fs.renameSync(profilePaths(name).root, trashedTo);
  return { name, trashedTo };
}
