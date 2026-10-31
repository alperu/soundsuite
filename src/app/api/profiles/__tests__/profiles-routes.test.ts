/**
 * @jest-environment node
 *
 * Profiles API on a server still on the pre-profiles layout (every Docker
 * install): rename "Default", add a profile, switch, delete, duplicates, and
 * the admin-only write gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// better-sqlite3 ships no .d.ts in this repo (same as lib/profiles/create.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database: any = require('better-sqlite3');
import { NextRequest, NextResponse } from 'next/server';

let role: 'admin' | 'viewer' | null = 'admin';
jest.mock('@/lib/api/route-guard', () => ({
  requireApiAccess: jest.fn(async (_req: unknown, opts: { requireAdminRole?: boolean }) => {
    if (role === null) return NextResponse.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, { status: 401 });
    if (opts.requireAdminRole && role !== 'admin') return NextResponse.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, { status: 401 });
    return null;
  }),
}));
jest.mock('@/lib/db/prisma', () => ({
  prisma: { case: { findMany: jest.fn(async () => []) } },
  releasePrismaClient: jest.fn(async () => undefined),
}));
jest.mock('@/lib/legal/kysely', () => ({ releaseKysely: jest.fn() }));
jest.mock('@/lib/profiles/switch', () => ({
  switchProfile: jest.fn(async (name: string) => {
    const reg = require('@/lib/profiles/registry') as typeof import('@/lib/profiles/registry');
    const from = reg.activeProfileName();
    reg.setActiveProfileName(name);
    return { from, to: name, changed: from !== name, restarted: [], warnings: [] };
  }),
}));

let root: string;
const saved = { root: process.env.SS_DATA_ROOT, db: process.env.DATABASE_URL, lance: process.env.LANCEDB_PATH, prof: process.env.SS_PROFILE };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

type Routes = {
  list: typeof import('../route');
  one: typeof import('../[name]/route');
  active: typeof import('../active/route');
};

function load(): Routes {
  jest.resetModules();
  (require('@/lib/profiles/registry') as typeof import('@/lib/profiles/registry')).resetActiveProfileCache();
  return {
    list: require('../route'),
    one: require('../[name]/route'),
    active: require('../active/route'),
  };
}

const req = (url: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://ss.test${url}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

beforeEach(() => {
  role = 'admin';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-profiles-routes-'));
  process.env.SS_DATA_ROOT = root;
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  const dbFile = path.join(root, 'db', 'sound-suite.db');
  const db = new Database(dbFile);
  db.exec('CREATE TABLE "Config" (id TEXT PRIMARY KEY, key TEXT UNIQUE, value TEXT, updatedAt INTEGER)');
  db.exec('CREATE TABLE "Case" (id TEXT PRIMARY KEY, name TEXT, caseNumber TEXT)');
  db.exec('CREATE TABLE "Document" (id TEXT PRIMARY KEY, caseId TEXT)');
  db.prepare('INSERT INTO "Config" VALUES (?, ?, ?, ?)').run('c1', 'fleet.source', 'follow', 0);
  db.prepare('INSERT INTO "Config" VALUES (?, ?, ?, ?)').run('c2', 'embedding.model', 'x', 0);
  db.close();
  process.env.DATABASE_URL = `file:${dbFile}`;
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

describe('profiles API on the pre-profiles layout', () => {
  it('lists one "Default" row before anything is written', async () => {
    const r = load();
    const res = await r.list.GET(req('/api/profiles'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ active: 'legacy', legacy: true });
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]).toMatchObject({ name: 'legacy', displayName: 'Default', adopted: true });
  });

  it('renames Default, adds a profile, switches both ways and deletes the new one', async () => {
    const r = load();
    // rename the legacy row → adopted as `default`
    let res = await r.one.PATCH(req('/api/profiles/legacy', 'PATCH', { displayName: 'Main' }), ctx('legacy'));
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toMatchObject({ name: 'default', displayName: 'Main' });

    // add a second profile; follow-mode keys carry over, others do not
    res = await r.list.POST(req('/api/profiles', 'POST', { name: 'test-profile', displayName: 'Test profile' }));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.profile).toMatchObject({ name: 'test-profile', displayName: 'Test profile' });
    const db = new Database(path.join(root, 'test-profile', 'sound-suite.db'), { readonly: true });
    expect(db.prepare('SELECT key FROM "Config"').all()).toEqual([{ key: 'fleet.source' }]);
    db.close();

    res = await r.list.GET(req('/api/profiles'));
    let body = await res.json();
    expect(body.legacy).toBe(false);
    expect(body.profiles.map((p: { name: string; displayName: string }) => [p.name, p.displayName])).toEqual([
      ['default', 'Main'],
      ['test-profile', 'Test profile'],
    ]);

    res = await r.active.POST(req('/api/profiles/active', 'POST', { name: 'test-profile' }));
    expect(res.status).toBe(200);
    expect((await (await r.active.GET(req('/api/profiles/active'))).json()).active).toBe('test-profile');
    res = await r.active.POST(req('/api/profiles/active', 'POST', { name: 'default' }));
    expect(res.status).toBe(200);

    // the adopted default cannot be deleted; the new one can
    await r.active.POST(req('/api/profiles/active', 'POST', { name: 'test-profile' }));
    res = await r.one.DELETE(req('/api/profiles/default', 'DELETE'), ctx('default'));
    expect(res.status).toBe(409);
    await r.active.POST(req('/api/profiles/active', 'POST', { name: 'default' }));
    res = await r.one.DELETE(req('/api/profiles/test-profile', 'DELETE'), ctx('test-profile'));
    expect(res.status).toBe(200);
    body = await (await r.list.GET(req('/api/profiles'))).json();
    expect(body.profiles.map((p: { name: string }) => p.name)).toEqual(['default']);
    // the original data file is still where it was
    expect(fs.existsSync(path.join(root, 'db', 'sound-suite.db'))).toBe(true);
  });

  it('answers 409 with a clear message on duplicate names', async () => {
    const r = load();
    await r.one.PATCH(req('/api/profiles/legacy', 'PATCH', { displayName: 'Main' }), ctx('legacy'));
    let res = await r.list.POST(req('/api/profiles', 'POST', { name: 'main2', displayName: 'main' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/already exists with the name "Main"/);
    res = await r.list.POST(req('/api/profiles', 'POST', { name: 'default' }));
    expect(res.status).toBe(409);
    res = await r.list.POST(req('/api/profiles', 'POST', { name: 'db' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/data folder with that name/);
  });

  it('refuses writes from a viewer and reads from an anonymous caller', async () => {
    const r = load();
    role = 'viewer';
    expect((await r.list.GET(req('/api/profiles'))).status).toBe(200);
    expect((await r.list.POST(req('/api/profiles', 'POST', { name: 'x' }))).status).toBe(401);
    expect((await r.one.PATCH(req('/api/profiles/legacy', 'PATCH', { displayName: 'M' }), ctx('legacy'))).status).toBe(401);
    expect(fs.existsSync(path.join(root, 'default'))).toBe(false);
    role = null;
    expect((await r.list.GET(req('/api/profiles'))).status).toBe(401);
  });
});
