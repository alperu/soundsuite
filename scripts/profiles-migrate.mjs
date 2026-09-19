#!/usr/bin/env node
/**
 * One-time move from the pre-profiles layout to `data/<profile>/…`
 * (docs/tasks/54-profiles.md).
 *
 *   node scripts/profiles-migrate.mjs <profile-name> [--dry-run] [--display "Name"]
 *
 * Moves (rename, same volume — no copy, no rewrite):
 *   prisma/data/sound-suite.db{,-wal,-shm}   → data/<name>/sound-suite.db{,-wal,-shm}
 *   data/lancedb/                            → data/<name>/lancedb/
 *   data/chat/                               → data/<name>/chat/
 *   data/chat-attachments/                   → data/<name>/chat-attachments/
 *   data/ocr-captures/                       → data/<name>/ocr-captures/
 * Leaves in place: every *.bak*, data/backups, data/lancedb-test, the static
 * data/*.json location files.
 * Writes: data/<name>/profile.json and data/profiles.json.
 * Rewrites .env: DATABASE_URL and LANCEDB_PATH point at the profile, so shell
 * scripts that still read them keep working.
 *
 * Refuses to run while the dashboard holds the database (checks for a
 * listener on :3000 / :3001 and a -wal file that is not empty). Stop it first:
 *   scripts/svc-ctl.sh stop
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const displayIdx = args.indexOf('--display');
const displayName = displayIdx >= 0 ? args[displayIdx + 1] : name;

if (!name || !/^[a-z0-9][a-z0-9-_]{0,39}$/.test(name) || name === 'legacy') {
  console.error('usage: node scripts/profiles-migrate.mjs <profile-name> [--dry-run] [--display "Name"]');
  console.error('       name: lowercase letters, digits, - or _; max 40; not "legacy"');
  process.exit(2);
}

const dataRoot = path.join(ROOT, 'data');
const target = path.join(dataRoot, name);

function envValue(key) {
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(new RegExp(`^${key}=\\s*"?([^"\\n]*)"?`, 'm'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
function legacySqlite() {
  const raw = process.env.DATABASE_URL || envValue('DATABASE_URL') || 'file:./data/sound-suite.db';
  const stripped = raw.replace(/^file:/, '');
  return path.isAbsolute(stripped) ? stripped : path.resolve(ROOT, 'prisma', stripped);
}
function legacyLance() {
  const raw = process.env.LANCEDB_PATH || envValue('LANCEDB_PATH') || './data/lancedb';
  return path.resolve(ROOT, raw);
}

function listening(port) {
  try {
    return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

const sqlite = legacySqlite();
const lance = legacyLance();
const moves = [
  [sqlite, path.join(target, 'sound-suite.db')],
  [`${sqlite}-wal`, path.join(target, 'sound-suite.db-wal')],
  [`${sqlite}-shm`, path.join(target, 'sound-suite.db-shm')],
  [lance, path.join(target, 'lancedb')],
  [path.join(dataRoot, 'chat'), path.join(target, 'chat')],
  [path.join(dataRoot, 'chat-attachments'), path.join(target, 'chat-attachments')],
  [path.join(dataRoot, 'ocr-captures'), path.join(target, 'ocr-captures')],
].filter(([from]) => fs.existsSync(from));

console.log(`Profile: ${name} (${displayName})`);
console.log(`Target:  ${target}`);
if (fs.existsSync(path.join(target, 'profile.json'))) {
  console.error('refusing: that profile already exists');
  process.exit(1);
}
if (!fs.existsSync(sqlite)) {
  console.error(`refusing: no database at ${sqlite} — nothing to migrate`);
  process.exit(1);
}
for (const [from, to] of moves) {
  console.log(`  ${path.relative(ROOT, from)}  →  ${path.relative(ROOT, to)}`);
}
if (dryRun) {
  console.log('dry run — nothing moved');
  process.exit(0);
}

if (listening(3000) || listening(3001)) {
  console.error('refusing: something listens on :3000/:3001 — stop the dashboard first (scripts/svc-ctl.sh stop)');
  process.exit(1);
}
const wal = `${sqlite}-wal`;
if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
  console.error(`refusing: ${path.relative(ROOT, wal)} is not empty — a writer may still be attached. Stop it, or open the DB once with sqlite3 to checkpoint.`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
for (const [from, to] of moves) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  console.log(`moved ${path.relative(ROOT, from)}`);
}
for (const d of ['lancedb', 'chat/history', 'chat-attachments', 'backups']) {
  fs.mkdirSync(path.join(target, d), { recursive: true });
}
fs.writeFileSync(
  path.join(target, 'profile.json'),
  JSON.stringify({ name, displayName, createdAt: new Date().toISOString(), description: 'migrated from the pre-profiles layout' }, null, 2) + '\n',
);
fs.writeFileSync(path.join(dataRoot, 'profiles.json'), JSON.stringify({ active: name, updatedAt: new Date().toISOString() }, null, 2) + '\n');

// .env: keep the legacy readers pointed at the right files.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  let env = fs.readFileSync(envPath, 'utf8');
  const set = (key, value) => {
    const line = `${key}="${value}"`;
    env = new RegExp(`^${key}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line) : env + `\n${line}\n`;
  };
  set('DATABASE_URL', `file:${path.join(target, 'sound-suite.db')}`);
  set('LANCEDB_PATH', path.join(target, 'lancedb'));
  fs.writeFileSync(envPath, env);
  console.log('.env updated (DATABASE_URL, LANCEDB_PATH → profile paths)');
}

console.log(`done — active profile is "${name}". Start the dashboard again (scripts/svc-ctl.sh start).`);
