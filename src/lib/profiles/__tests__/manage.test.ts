/** @jest-environment node */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
const saved = process.env.SS_DATA_ROOT;

function load() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require('../registry') as typeof import('../registry');
  registry.resetActiveProfileCache();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const manage = require('../manage') as typeof import('../manage');
  return { registry, manage };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-profiles-manage-'));
  process.env.SS_DATA_ROOT = root;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.SS_DATA_ROOT; else process.env.SS_DATA_ROOT = saved;
});

describe('updateProfile', () => {
  it('edits display name and description on any profile, including the active one', () => {
    const { registry, manage } = load();
    registry.scaffoldProfile('alpha', { displayName: 'Alpha', createdAt: 'now' });
    registry.setActiveProfileName('alpha');
    const m = manage.updateProfile('alpha', { displayName: '  Alpha Prime ', description: 'main set' });
    expect(m).toMatchObject({ name: 'alpha', displayName: 'Alpha Prime', description: 'main set' });
    expect(manage.updateProfile('alpha', { description: null }).description).toBeUndefined();
    expect(() => manage.updateProfile('alpha', { displayName: '  ' })).toThrow(/cannot be empty/);
  });

  it('renames a non-active profile directory and refuses to rename the active one', () => {
    const { registry, manage } = load();
    registry.scaffoldProfile('alpha', { displayName: 'Alpha', createdAt: 'now' });
    registry.scaffoldProfile('beta', { displayName: 'Beta', createdAt: 'now' });
    registry.setActiveProfileName('alpha');
    fs.writeFileSync(path.join(root, 'beta', 'sound-suite.db'), 'x');

    const renamed = manage.updateProfile('beta', { newName: 'gamma' });
    expect(renamed.name).toBe('gamma');
    expect(fs.existsSync(path.join(root, 'gamma', 'sound-suite.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'beta'))).toBe(false);
    expect(registry.listProfiles().map((p) => p.name)).toEqual(['alpha', 'gamma']);

    expect(() => manage.updateProfile('alpha', { newName: 'delta' })).toThrow(/active profile/);
    expect(() => manage.updateProfile('gamma', { newName: 'alpha' })).toThrow(/already exists/);
    expect(() => manage.updateProfile('gamma', { newName: 'Bad Name' })).toThrow(/invalid profile name/);
  });
});

describe('deleteProfile', () => {
  it('moves a non-active profile to .trash and refuses the active or last one', () => {
    const { registry, manage } = load();
    registry.scaffoldProfile('alpha', { displayName: 'Alpha', createdAt: 'now' });
    registry.scaffoldProfile('beta', { displayName: 'Beta', createdAt: 'now' });
    registry.setActiveProfileName('alpha');

    expect(() => manage.deleteProfile('alpha')).toThrow(/active profile/);
    const res = manage.deleteProfile('beta');
    expect(res.trashedTo.startsWith(path.join(root, '.trash', 'beta-'))).toBe(true);
    expect(fs.existsSync(res.trashedTo)).toBe(true);
    expect(registry.listProfiles().map((p) => p.name)).toEqual(['alpha']);
    // .trash is not a profile: it carries no manifest and fails the name rule.
    expect(() => manage.deleteProfile('ghost')).toThrow(/not found/);
    registry.setActiveProfileName('alpha');
    expect(() => manage.deleteProfile('alpha')).toThrow(/active profile/);
  });
});
