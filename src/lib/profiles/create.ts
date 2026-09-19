/**
 * Creating a profile: directory skeleton, an empty schema-migrated SQLite
 * file, an empty LanceDB directory, and optionally the `Config` rows copied
 * from another profile so API keys and model choices carry over.
 *
 * The schema is applied with `prisma migrate deploy` against the new file —
 * the same command `npm run db:migrate` runs — so a new profile is at the
 * same migration level as the code, never at a hand-copied one.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { activeProfile, listProfiles, profilePaths, readManifest, scaffoldProfile, type ProfileManifest, type ProfilePaths } from './registry';

// better-sqlite3 ships no .d.ts in this repo (same as lib/legal/kysely.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const Database: any = require('better-sqlite3');

const execFileAsync = promisify(execFile);

export interface CreateProfileOptions {
  name: string;
  displayName?: string;
  description?: string;
  /** Copy the `Config` table (API keys, models, worker counts) from this profile. */
  copySettingsFrom?: string;
  /**
   * Take the database SCHEMA from this profile (default: the active one, else
   * any profile with a database). Only when no profile has a database at all
   * does creation fall back to `prisma migrate deploy`.
   */
  schemaFrom?: string;
}

export async function migrateSqlite(sqlitePath: string): Promise<void> {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  // Prisma resolves a relative file: URL against prisma/, so hand it the
  // absolute path and there is nothing to resolve.
  await execFileAsync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` },
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * Clone the SCHEMA (tables, indexes, triggers — no rows) of one profile's
 * SQLite into a new file, plus the `_prisma_migrations` ledger so a later
 * `migrate deploy` sees the same history.
 *
 * Preferred over the Prisma CLI for a new profile: the running profile's
 * schema is, by definition, the one the code works against, and neither CLI
 * path is reliable on an empty file here — `db push` trips over the JSON
 * `@default("{}")` DDL on SQLite and `migrate deploy` fails on a migration
 * that assumes prior data. This is exact, offline, and takes milliseconds.
 */
export function cloneSchema(fromSqlite: string, toSqlite: string): { objects: number; migrations: number } {
  fs.mkdirSync(path.dirname(toSqlite), { recursive: true });
  const src = new Database(fromSqlite, { readonly: true, fileMustExist: true });
  const dst = new Database(toSqlite);
  try {
    const objects = src
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
          "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, rowid",
      )
      .all() as Array<{ type: string; name: string; sql: string }>;
    dst.pragma('journal_mode = WAL');
    const apply = dst.transaction((list: typeof objects) => {
      for (const o of list) dst.exec(o.sql);
    });
    apply(objects);

    let migrations = 0;
    const hasLedger = objects.some((o) => o.type === 'table' && o.name === '_prisma_migrations');
    if (hasLedger) {
      const rows = src.prepare('SELECT * FROM "_prisma_migrations"').all() as Array<Record<string, unknown>>;
      if (rows.length) {
        const cols = Object.keys(rows[0]);
        const insert = dst.prepare(
          `INSERT INTO "_prisma_migrations" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        );
        const tx = dst.transaction((list: typeof rows) => {
          for (const r of list) insert.run(...cols.map((c) => r[c]));
        });
        tx(rows);
        migrations = rows.length;
      }
    }
    return { objects: objects.length, migrations };
  } finally {
    src.close();
    dst.close();
  }
}

/**
 * Copy every row of `table` from one SQLite file to another, `INSERT OR
 * IGNORE` so an existing primary key wins. Used to seed `data/system.db`
 * from the profiles that existed before the system split.
 */
export function copyTableRows(fromSqlite: string, toSqlite: string, table: string): number {
  const src = new Database(fromSqlite, { readonly: true, fileMustExist: true });
  const dst = new Database(toSqlite, { fileMustExist: true });
  try {
    const exists = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) return 0;
    const rows = src.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return 0;
    const cols = Object.keys(rows[0]);
    const insert = dst.prepare(
      `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    );
    const tx = dst.transaction((list: typeof rows) => {
      let n = 0;
      for (const r of list) n += insert.run(...cols.map((c) => r[c])).changes;
      return n;
    });
    return tx(rows) as number;
  } finally {
    src.close();
    dst.close();
  }
}

export function copyConfigRows(fromSqlite: string, toSqlite: string): number {
  const src = new Database(fromSqlite, { readonly: true, fileMustExist: true });
  const dst = new Database(toSqlite, { fileMustExist: true });
  try {
    const rows = src.prepare('SELECT id, key, value, updatedAt FROM "Config"').all() as Array<{ id: string; key: string; value: string; updatedAt: number | string }>;
    const insert = dst.prepare('INSERT OR REPLACE INTO "Config" (id, key, value, updatedAt) VALUES (?, ?, ?, ?)');
    const tx = dst.transaction((list: typeof rows) => {
      for (const r of list) insert.run(r.id, r.key, r.value, r.updatedAt);
    });
    tx(rows);
    return rows.length;
  } finally {
    src.close();
    dst.close();
  }
}

export async function createProfile(opts: CreateProfileOptions): Promise<{ manifest: ProfileManifest; paths: ProfilePaths; copiedSettings: number }> {
  const name = opts.name.trim().toLowerCase();
  if (readManifest(name)) throw new Error(`profile already exists: ${name}`);
  if (opts.copySettingsFrom && !readManifest(opts.copySettingsFrom)) {
    throw new Error(`copySettingsFrom profile not found: ${opts.copySettingsFrom}`);
  }
  const schemaSource = pickSchemaSource(opts.schemaFrom);
  const paths = scaffoldProfile(name, {
    displayName: opts.displayName?.trim() || name,
    createdAt: new Date().toISOString(),
    ...(opts.description ? { description: opts.description } : {}),
  });
  try {
    if (schemaSource) cloneSchema(schemaSource, paths.sqlite);
    else await migrateSqlite(paths.sqlite);
    let copiedSettings = 0;
    if (opts.copySettingsFrom) {
      copiedSettings = copyConfigRows(profilePaths(opts.copySettingsFrom).sqlite, paths.sqlite);
    }
    return { manifest: readManifest(name)!, paths, copiedSettings };
  } catch (err) {
    // A half-made profile would be discovered on the next listing and offered
    // as a real one. Remove the skeleton so a retry starts clean.
    fs.rmSync(paths.root, { recursive: true, force: true });
    throw err;
  }
}

/** The SQLite file whose schema a new profile copies, or null to use the CLI. */
function pickSchemaSource(explicit?: string): string | null {
  if (explicit) {
    const p = profilePaths(explicit).sqlite;
    if (!fs.existsSync(p)) throw new Error(`schemaFrom profile has no database: ${explicit}`);
    return p;
  }
  const active = activeProfile();
  if (!active.legacy && fs.existsSync(active.sqlite)) return active.sqlite;
  if (active.legacy && fs.existsSync(active.sqlite)) return active.sqlite;
  for (const m of listProfiles()) {
    const p = profilePaths(m.name).sqlite;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Cases in a profile that is NOT active, read straight from its SQLite. */
export function peekCases(name: string): Array<{ id: string; name: string; caseNumber: string | null; documents: number }> {
  const p = profilePaths(name);
  if (!fs.existsSync(p.sqlite)) return [];
  const db = new Database(p.sqlite, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        'SELECT c.id, c.name, c.caseNumber, (SELECT COUNT(*) FROM "Document" d WHERE d.caseId = c.id) AS documents ' +
          'FROM "Case" c ORDER BY c.name',
      )
      .all() as Array<{ id: string; name: string; caseNumber: string | null; documents: number }>;
  } catch {
    // A profile whose schema is behind (or empty) answers with no cases, not an error.
    return [];
  } finally {
    db.close();
  }
}
