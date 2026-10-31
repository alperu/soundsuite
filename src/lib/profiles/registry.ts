/**
 * Profiles — Chrome-style, one active at a time (docs/tasks/54-profiles.md).
 *
 * A profile is a directory under `data/` that carries a `profile.json`:
 *
 *   data/<name>/profile.json
 *   data/<name>/sound-suite.db          SQLite (Prisma + Kysely)
 *   data/<name>/lancedb/                vectors
 *   data/<name>/chat/                   chat history
 *   data/<name>/chat-attachments/
 *   data/<name>/ocr-captures/
 *   data/<name>/backups/
 *
 * Nothing in code lists profile names: they are discovered from disk. The
 * registry file `data/profiles.json` holds only which one is active. The
 * `SS_PROFILE` env var overrides the registry at boot (launchd / prod).
 *
 * This module is synchronous and imports nothing from the app, because the
 * Prisma proxy has to answer "which profile" on every property access and
 * the config module must not become a dependency of the database module.
 *
 * **Legacy mode.** Until the operator has run `scripts/profiles-migrate.mjs`
 * there is no registry and no profile directory. `activeProfile()` then
 * returns the synthetic `legacy` profile whose paths come from
 * `DATABASE_URL` / `LANCEDB_PATH` and the old `data/` layout — every caller
 * keeps working exactly as before the feature existed.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PROFILE_FILE = 'profile.json';
export const REGISTRY_FILE = 'profiles.json';
export const LEGACY_PROFILE = 'legacy';
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,39}$/;

/**
 * Absolute data locations for a profile whose data does NOT live under
 * `data/<name>/` — the pre-profiles data adopted in place
 * (`lib/profiles/adopt.ts`). Nothing is moved; the manifest points at it.
 */
export interface ProfileStorage {
  sqlite: string;
  lancedb: string;
  chat: string;
  chatAttachments: string;
  ocrCaptures: string;
  backups: string;
}

const STORAGE_KEYS = ['sqlite', 'lancedb', 'chat', 'chatAttachments', 'ocrCaptures', 'backups'] as const;

export interface ProfileManifest {
  name: string;
  displayName: string;
  createdAt: string;
  description?: string;
  storage?: ProfileStorage;
}

export interface ProfilePaths {
  name: string;
  root: string;
  sqlite: string;
  lancedb: string;
  chat: string;
  chatHistory: string;
  chatAttachments: string;
  ocrCaptures: string;
  backups: string;
  legacy: boolean;
}

interface Registry {
  active: string;
  updatedAt: string;
}

const g = globalThis as unknown as {
  __ssProfileActive?: string;
  __ssProfileBootOverride?: string | null;
  /** name → storage override (null = standard layout). `profilePaths` runs on
   *  every Prisma property access, so the manifest is read once, not per call. */
  __ssProfileStorage?: Map<string, ProfileStorage | null>;
};

function storageCache(): Map<string, ProfileStorage | null> {
  if (!g.__ssProfileStorage) g.__ssProfileStorage = new Map();
  return g.__ssProfileStorage;
}

function storageFor(name: string): ProfileStorage | null {
  const cache = storageCache();
  const key = `${dataRoot()}\0${name}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const s = readManifest(name)?.storage ?? null;
  cache.set(key, s);
  return s;
}

/** Forget cached storage overrides. Called after any manifest write or move. */
export function forgetProfileStorageCache(): void {
  g.__ssProfileStorage = undefined;
}

function parseStorage(v: unknown): ProfileStorage | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: Partial<ProfileStorage> = {};
  for (const k of STORAGE_KEYS) {
    const p = o[k];
    if (typeof p !== 'string' || !path.isAbsolute(p)) return undefined;
    out[k] = p;
  }
  return out as ProfileStorage;
}

/** `data/` under the project, or `SS_DATA_ROOT` (tests, relocated installs). */
export function dataRoot(): string {
  const override = process.env.SS_DATA_ROOT?.trim();
  return override ? path.resolve(override) : path.resolve(process.cwd(), 'data');
}

function registryPath(): string {
  return path.join(dataRoot(), REGISTRY_FILE);
}

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name) && name !== LEGACY_PROFILE;
}

/** Legacy resolution, mirrored from `lib/db/prisma.ts` so both agree. */
function legacySqlitePath(): string {
  const url = process.env.DATABASE_URL ?? 'file:./data/sound-suite.db';
  const stripped = url.startsWith('file:') ? url.slice('file:'.length) : url;
  if (path.isAbsolute(stripped)) return stripped;
  return path.resolve(process.cwd(), 'prisma', stripped);
}

export function legacyPaths(): ProfilePaths {
  const root = dataRoot();
  return {
    name: LEGACY_PROFILE,
    root,
    sqlite: legacySqlitePath(),
    lancedb: path.resolve(process.cwd(), process.env.LANCEDB_PATH || './data/lancedb'),
    chat: path.join(root, 'chat'),
    chatHistory: path.join(root, 'chat', 'history'),
    chatAttachments: path.join(root, 'chat-attachments'),
    ocrCaptures: path.join(root, 'ocr-captures'),
    backups: path.resolve(process.cwd(), process.env.BACKUP_DIR || './data/backups'),
    legacy: true,
  };
}

export function profilePaths(name: string): ProfilePaths {
  if (name === LEGACY_PROFILE) return legacyPaths();
  const root = path.join(dataRoot(), name);
  const storage = storageFor(name);
  if (storage) {
    return {
      name,
      root,
      sqlite: storage.sqlite,
      lancedb: storage.lancedb,
      chat: storage.chat,
      chatHistory: path.join(storage.chat, 'history'),
      chatAttachments: storage.chatAttachments,
      ocrCaptures: storage.ocrCaptures,
      backups: storage.backups,
      legacy: false,
    };
  }
  return {
    name,
    root,
    sqlite: path.join(root, 'sound-suite.db'),
    lancedb: path.join(root, 'lancedb'),
    chat: path.join(root, 'chat'),
    chatHistory: path.join(root, 'chat', 'history'),
    chatAttachments: path.join(root, 'chat-attachments'),
    ocrCaptures: path.join(root, 'ocr-captures'),
    backups: path.join(root, 'backups'),
    legacy: false,
  };
}

export function readManifest(name: string): ProfileManifest | null {
  try {
    const raw = fs.readFileSync(path.join(dataRoot(), name, PROFILE_FILE), 'utf8');
    const m = JSON.parse(raw) as Partial<ProfileManifest>;
    const storage = parseStorage(m.storage);
    return {
      name,
      displayName: typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName : name,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      ...(storage ? { storage } : {}),
    };
  } catch {
    return null;
  }
}

/** Write `data/<name>/profile.json` (the directory must exist). */
export function writeManifestFile(name: string, manifest: ProfileManifest): void {
  const file = path.join(dataRoot(), name, PROFILE_FILE);
  const { name: _n, ...rest } = manifest;
  void _n;
  fs.writeFileSync(file, JSON.stringify({ ...rest, name }, null, 2) + '\n');
  forgetProfileStorageCache();
}

/** Another profile already shows this display name (case-insensitive)? */
export function displayNameTaken(displayName: string, exceptName?: string): ProfileManifest | null {
  const want = displayName.trim().toLowerCase();
  return listProfiles().find((p) => p.name !== exceptName && p.displayName.trim().toLowerCase() === want) ?? null;
}

/** Every directory under data/ that carries a manifest, sorted by name. */
export function listProfiles(): ProfileManifest[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dataRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ProfileManifest[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isValidProfileName(e.name)) continue;
    const m = readManifest(e.name);
    if (m) out.push(m);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readRegistry(): Registry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as Partial<Registry>;
    if (typeof raw.active !== 'string') return null;
    return { active: raw.active, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '' };
  } catch {
    return null;
  }
}

function writeRegistry(reg: Registry): void {
  fs.mkdirSync(dataRoot(), { recursive: true });
  const tmp = registryPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, registryPath());
}

/** True once at least one profile directory exists. */
export function profilesEnabled(): boolean {
  return listProfiles().length > 0;
}

/**
 * The active profile name. Resolution, once per process (cached on
 * globalThis so HMR does not re-decide):
 *   1. `SS_PROFILE` env, if it names an existing profile;
 *   2. `data/profiles.json`, if it names an existing profile;
 *   3. the first profile on disk;
 *   4. `legacy` — no profiles exist.
 * `setActiveProfileName` updates the cache; nothing else does.
 */
export function activeProfileName(): string {
  if (g.__ssProfileActive) return g.__ssProfileActive;
  const profiles = listProfiles();
  const names = new Set(profiles.map((p) => p.name));
  let chosen: string | null = null;
  const env = process.env.SS_PROFILE?.trim();
  if (env && names.has(env)) chosen = env;
  if (!chosen) {
    const reg = readRegistry();
    if (reg && names.has(reg.active)) chosen = reg.active;
  }
  if (!chosen && profiles.length) chosen = profiles[0].name;
  g.__ssProfileActive = chosen ?? LEGACY_PROFILE;
  return g.__ssProfileActive;
}

export function activeProfile(): ProfilePaths {
  return profilePaths(activeProfileName());
}

/**
 * Persist and cache a new active profile. Pure bookkeeping — the runtime
 * switch (clients, services) is `lib/profiles/switch.ts`.
 */
export function setActiveProfileName(name: string): ProfilePaths {
  if (!isValidProfileName(name)) throw new Error(`invalid profile name: ${name}`);
  if (!readManifest(name)) throw new Error(`profile not found: ${name}`);
  writeRegistry({ active: name, updatedAt: new Date().toISOString() });
  g.__ssProfileActive = name;
  return profilePaths(name);
}

/** Forget the cached choice (tests, and the migration script). */
export function resetActiveProfileCache(): void {
  g.__ssProfileActive = undefined;
  forgetProfileStorageCache();
}

/** Make the directory skeleton and the manifest. Idempotent. */
export function scaffoldProfile(name: string, manifest: Omit<ProfileManifest, 'name'>): ProfilePaths {
  if (!isValidProfileName(name)) throw new Error(`invalid profile name: ${name} (lowercase letters, digits, - and _, max 40)`);
  const p = profilePaths(name);
  for (const dir of [p.root, p.lancedb, p.chatHistory, p.chatAttachments, p.backups]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const file = path.join(p.root, PROFILE_FILE);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ ...manifest, name }, null, 2) + '\n');
  }
  return p;
}
