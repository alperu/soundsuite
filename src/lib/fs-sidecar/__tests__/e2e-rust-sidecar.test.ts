/**
 * @jest-environment node
 *
 * End-to-end: the real Rust sidecar (fileSystemSideCar, `folder-status`
 * profile, direction = "connect") logs in to this TS master, sends folder
 * totals, and the master stores them in SQLite through Prisma.
 *
 * Needs the release binary: `cargo build -p sidecar --release` in
 * fileSystemSideCar. Set FS_SIDECAR_BIN to point at it; skipped when absent.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { startFsSidecarLink, type FsLinkServer } from '../server';
import { PrismaFolderStatStore, listFolderStats, type FolderStatDb } from '../folder-store';
import { __resetFsSidecarsForTests, getFsSidecar } from '../status';

const BIN =
  process.env.FS_SIDECAR_BIN ||
  path.resolve(process.cwd(), '..', 'fileSystemSideCar', 'target', 'release', 'expedat-sidecar');
const MIGRATION = path.join(process.cwd(), 'prisma', 'migrations', '20261029120000_add_folder_stat', 'migration.sql');
const run = fs.existsSync(BIN) ? describe : describe.skip;

jest.setTimeout(90_000);

async function waitFor<T>(what: string, f: () => Promise<T | undefined | null | false>, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

run('Rust sidecar -> SoundSuite folder-status (e2e)', () => {
  let tmp: string;
  let root: string;
  let srv: FsLinkServer;
  let prisma: PrismaClient;
  let child: ChildProcess;
  let log = '';

  beforeAll(async () => {
    __resetFsSidecarsForTests();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-sidecar-e2e-'));
    root = path.join(tmp, 'root');
    fs.mkdirSync(path.join(root, 'album1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'album1', 'a.wav'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(root, 'top.txt'), Buffer.alloc(10));

    const dbPath = path.join(tmp, 'ss.db');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    db.close();
    prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });

    srv = await startFsSidecarLink({
      port: 0,
      host: '127.0.0.1',
      credentials: { mac: 'e2e-pw' },
      store: new PrismaFolderStatStore(prisma as unknown as FolderStatDb),
      serverVersion: 'soundsuite-e2e',
    });

    const state = path.join(tmp, 'state');
    fs.mkdirSync(path.join(state, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(state, 'secrets', 'soundsuite.pw'), 'e2e-pw', { mode: 0o600 });
    const cfg = path.join(tmp, 'sidecar.toml');
    fs.writeFileSync(
      cfg,
      [
        '[sidecar]',
        'id = "e2e-host"',
        'listen_ip = "127.0.0.1"',
        `listen_port = ${20000 + Math.floor(Math.random() * 20000)}`,
        `state_dir = ${JSON.stringify(state)}`,
        '[ui]',
        'enabled = false',
        '[[master]]',
        'id = "soundsuite"',
        'profile = "folder-status"',
        'direction = "connect"',
        `url = "http://127.0.0.1:${srv.port}"`,
        'username = "mac"',
        'password_ref = "file:soundsuite.pw"',
        '[[master.root]]',
        'name = "music"',
        `path = ${JSON.stringify(root)}`,
        '',
      ].join('\n'),
    );
    child = spawn(BIN, ['run', '--config', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => (log += d));
    child.stderr?.on('data', (d) => (log += d));
  });

  afterAll(async () => {
    child?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    await srv?.close();
    await prisma?.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const stats = () => listFolderStats(prisma as unknown as FolderStatDb, { sidecarId: 'e2e-host' });
  const at = async (p: string) => (await stats()).find((s) => s.path === p);

  test('initial scan: totals per folder are stored, link shows websocket + version', async () => {
    const top = await waitFor('root totals', async () => {
      const r = await at('');
      return r && r.recFileCount === 2 ? r : null;
    }).catch((e) => {
      throw new Error(`${e.message}\n--- sidecar log ---\n${log.slice(-3000)}`);
    });
    expect(top.recTotalBytes).toBe(1010);
    expect(top.fileCount).toBe(1);
    expect(top.root).toBe('music');
    const album = await at('album1');
    expect(album).toMatchObject({ fileCount: 1, recFileCount: 1, recTotalBytes: 1000 });

    const st = getFsSidecar('e2e-host');
    expect(st?.version).toBe('0.1.0');
    expect(st?.profiles).toContain('folder-status');
    expect(st?.connectionMode).toBe('websocket');
    expect(st?.confirmedSeq).toBeGreaterThan(0);
  });

  test('file changes update the stored totals; a deleted folder is removed', async () => {
    fs.mkdirSync(path.join(root, 'album2'));
    fs.writeFileSync(path.join(root, 'album2', 'b.wav'), Buffer.alloc(500));
    fs.writeFileSync(path.join(root, 'album1', 'c.wav'), Buffer.alloc(200));
    await waitFor('new totals', async () => {
      const r = await at('');
      return r && r.recFileCount === 4 && r.recTotalBytes === 1710;
    });
    expect(await at('album1')).toMatchObject({ recFileCount: 2, recTotalBytes: 1200 });
    expect(await at('album2')).toMatchObject({ recFileCount: 1, recTotalBytes: 500 });

    fs.rmSync(path.join(root, 'album2'), { recursive: true });
    await waitFor('album2 removed', async () => !(await at('album2')));
    expect(await at('')).toMatchObject({ recFileCount: 3, recTotalBytes: 1210 });
  });
});
