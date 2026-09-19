/** @jest-environment node */

/**
 * Profile discovery and the active-profile resolution order, over a temp
 * data root. No database is opened here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
const savedEnv = { SS_DATA_ROOT: process.env.SS_DATA_ROOT, SS_PROFILE: process.env.SS_PROFILE };

function load() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../registry') as typeof import('../registry');
  // The active name is cached on globalThis (it survives HMR on purpose), so
  // a fresh module is not a fresh decision unless the cache is cleared.
  mod.resetActiveProfileCache();
  return mod;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-profiles-'));
  process.env.SS_DATA_ROOT = root;
  delete process.env.SS_PROFILE;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedEnv.SS_DATA_ROOT === undefined) delete process.env.SS_DATA_ROOT; else process.env.SS_DATA_ROOT = savedEnv.SS_DATA_ROOT;
  if (savedEnv.SS_PROFILE === undefined) delete process.env.SS_PROFILE; else process.env.SS_PROFILE = savedEnv.SS_PROFILE;
});

describe('profile registry', () => {
  it('is legacy when no profile directory exists, and legacy paths follow DATABASE_URL', () => {
    const r = load();
    expect(r.listProfiles()).toEqual([]);
    expect(r.profilesEnabled()).toBe(false);
    expect(r.activeProfileName()).toBe('legacy');
    const p = r.activeProfile();
    expect(p.legacy).toBe(true);
    expect(p.lancedb).toBe(path.resolve(process.cwd(), process.env.LANCEDB_PATH || './data/lancedb'));
  });

  it('discovers only directories that carry profile.json, sorted', () => {
    const r = load();
    r.scaffoldProfile('zeta', { displayName: 'Zeta', createdAt: 'now' });
    r.scaffoldProfile('alpha', { displayName: 'Alpha', createdAt: 'now' });
    fs.mkdirSync(path.join(root, 'not-a-profile'));
    fs.mkdirSync(path.join(root, 'lancedb'));
    expect(r.listProfiles().map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect(r.readManifest('alpha')?.displayName).toBe('Alpha');
    expect(fs.existsSync(path.join(root, 'alpha', 'lancedb'))).toBe(true);
  });

  it('resolves active: SS_PROFILE, then profiles.json, then the first on disk', () => {
    let r = load();
    r.scaffoldProfile('alpha', { displayName: 'Alpha', createdAt: 'now' });
    r.scaffoldProfile('beta', { displayName: 'Beta', createdAt: 'now' });
    expect(r.activeProfileName()).toBe('alpha');

    r = load();
    r.setActiveProfileName('beta');
    expect(r.readRegistry()?.active).toBe('beta');
    r = load();
    expect(r.activeProfileName()).toBe('beta');

    process.env.SS_PROFILE = 'alpha';
    r = load();
    expect(r.activeProfileName()).toBe('alpha');

    // An env naming a profile that does not exist is ignored, not trusted.
    process.env.SS_PROFILE = 'ghost';
    r = load();
    expect(r.activeProfileName()).toBe('beta');
  });

  it('refuses invalid names and unknown profiles', () => {
    const r = load();
    r.scaffoldProfile('alpha', { displayName: 'Alpha', createdAt: 'now' });
    expect(r.isValidProfileName('Alper')).toBe(false);
    expect(r.isValidProfileName('legacy')).toBe(false);
    expect(r.isValidProfileName('demo-2')).toBe(true);
    expect(() => r.setActiveProfileName('../etc')).toThrow(/invalid profile name/);
    expect(() => r.setActiveProfileName('ghost')).toThrow(/profile not found/);
    expect(() => r.scaffoldProfile('legacy', { displayName: 'x', createdAt: 'now' })).toThrow(/invalid profile name/);
  });

  it('gives every profile its own sqlite, lancedb, chat and backup paths', () => {
    const r = load();
    const p = r.profilePaths('demo');
    expect(p.legacy).toBe(false);
    expect(p.sqlite).toBe(path.join(root, 'demo', 'sound-suite.db'));
    expect(p.lancedb).toBe(path.join(root, 'demo', 'lancedb'));
    expect(p.chatAttachments).toBe(path.join(root, 'demo', 'chat-attachments'));
    expect(p.backups).toBe(path.join(root, 'demo', 'backups'));
  });
});
