/** @jest-environment node */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('@/lib/db/prisma', () => ({ releasePrismaClient: jest.fn(async () => undefined) }));
jest.mock('@/lib/legal/kysely', () => ({ releaseKysely: jest.fn() }));

let root: string;
const saved = { root: process.env.SS_DATA_ROOT, db: process.env.DATABASE_URL, lance: process.env.LANCEDB_PATH, prof: process.env.SS_PROFILE };

function load() {
  jest.resetModules();
  const registry = require('../registry') as typeof import('../registry');
  registry.resetActiveProfileCache();
  const adopt = require('../adopt') as typeof import('../adopt');
  const manage = require('../manage') as typeof import('../manage');
  return { registry, adopt, manage };
}

function restore(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-profiles-adopt-'));
  process.env.SS_DATA_ROOT = root;
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db', 'sound-suite.db'), 'x');
  process.env.DATABASE_URL = `file:${path.join(root, 'db', 'sound-suite.db')}`;
  process.env.LANCEDB_PATH = path.join(root, 'lancedb');
  delete process.env.SS_PROFILE;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  restore('SS_DATA_ROOT', saved.root);
  restore('DATABASE_URL', saved.db);
  restore('LANCEDB_PATH', saved.lance);
  restore('SS_PROFILE', saved.prof);
});

describe('adoptLegacyIfNeeded', () => {
  it('turns the pre-profiles data into profile "default" in place, with no files moved', async () => {
    const { registry, adopt } = load();
    expect(registry.activeProfileName()).toBe('legacy');

    const res = await adopt.adoptLegacyIfNeeded();
    expect(res).toEqual({ adopted: true, name: 'default' });
    expect(registry.activeProfileName()).toBe('default');
    expect(registry.listProfiles().map((p) => p.name)).toEqual(['default']);

    const p = registry.activeProfile();
    expect(p.legacy).toBe(false);
    expect(p.sqlite).toBe(path.join(root, 'db', 'sound-suite.db'));
    expect(p.lancedb).toBe(path.join(root, 'lancedb'));
    expect(fs.existsSync(path.join(root, 'db', 'sound-suite.db'))).toBe(true);
    expect(adopt.isAdoptedProfile('default')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8')).active).toBe('default');
  });

  it('is a no-op once a profile exists', async () => {
    const { registry, adopt } = load();
    registry.scaffoldProfile('alpha', { displayName: 'Alpha', createdAt: 'now' });
    expect(await adopt.adoptLegacyIfNeeded()).toEqual({ adopted: false, name: 'alpha' });
    expect(fs.existsSync(path.join(root, 'default'))).toBe(false);
  });

  it('lets the adopted profile be renamed (display name) but never deleted', async () => {
    const { registry, adopt, manage } = load();
    await adopt.adoptLegacyIfNeeded();
    expect(manage.updateProfile('default', { displayName: 'Main' }).displayName).toBe('Main');
    // storage survives a manifest rewrite
    expect(registry.activeProfile().sqlite).toBe(path.join(root, 'db', 'sound-suite.db'));

    registry.scaffoldProfile('test-profile', { displayName: 'Test profile', createdAt: 'now' });
    registry.setActiveProfileName('test-profile');
    expect(() => manage.deleteProfile('default')).toThrow(/cannot delete the default profile/);
  });
});

describe('duplicate names', () => {
  it('refuses a display name another profile already uses (case-insensitive)', () => {
    const { registry, manage } = load();
    registry.scaffoldProfile('alpha', { displayName: 'Main', createdAt: 'now' });
    registry.scaffoldProfile('beta', { displayName: 'Beta', createdAt: 'now' });
    registry.setActiveProfileName('alpha');
    expect(() => manage.updateProfile('beta', { displayName: ' main ' })).toThrow(/already exists/);
    expect(registry.readManifest('beta')?.displayName).toBe('Beta');
    // its own name is fine
    expect(manage.updateProfile('alpha', { displayName: 'MAIN' }).displayName).toBe('MAIN');
  });

  it('a refused folder rename leaves the display name untouched', () => {
    const { registry, manage } = load();
    registry.scaffoldProfile('alpha', { displayName: 'Alpha', createdAt: 'now' });
    registry.setActiveProfileName('alpha');
    expect(() => manage.updateProfile('alpha', { displayName: 'New', newName: 'other' })).toThrow(/active profile/);
    expect(registry.readManifest('alpha')?.displayName).toBe('Alpha');
  });

  it('refuses a folder name that is already a non-profile data folder', () => {
    const { registry, manage } = load();
    registry.scaffoldProfile('alpha', { displayName: 'Alpha', createdAt: 'now' });
    registry.scaffoldProfile('beta', { displayName: 'Beta', createdAt: 'now' });
    registry.setActiveProfileName('alpha');
    expect(() => manage.updateProfile('beta', { newName: 'db' })).toThrow(/data folder with that name/);
  });
});
