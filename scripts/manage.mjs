#!/usr/bin/env node

/**
 * Cross-platform process manager for Sound Suite.
 *
 * Replaces Bash-only scripts (start.sh, stop.sh, restart.sh, health-check.sh,
 * db-backup.sh, db-migrate.sh, db-restore.sh) with a single Node.js entry point
 * that works on macOS, Linux, and Windows.
 *
 * Usage:
 *   node scripts/manage.mjs start [dev|production]
 *   node scripts/manage.mjs stop
 *   node scripts/manage.mjs restart [dev|production]
 *   node scripts/manage.mjs health
 *   node scripts/manage.mjs db:migrate
 *   node scripts/manage.mjs db:backup [--output dir]
 *   node scripts/manage.mjs db:restore <backup-dir>
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ── Paths ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const PROJECT_ROOT = path.dirname(SCRIPT_DIR);
const PID_DIR = path.join(PROJECT_ROOT, '.pids');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

// ── Colors ─────────────────────────────────────────────────────────────────

const C = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  blue: '\x1b[0;34m',
  cyan: '\x1b[0;36m',
  nc: '\x1b[0m',
};

const info  = (msg) => console.log(`${C.blue}[INFO]${C.nc} ${msg}`);
const ok    = (msg) => console.log(`${C.green}[SUCCESS]${C.nc} ${msg}`);
const warn  = (msg) => console.log(`${C.yellow}[WARNING]${C.nc} ${msg}`);
const err   = (msg) => console.log(`${C.red}[ERROR]${C.nc} ${msg}`);
const banner = (msg) => {
  const line = `${C.green}${'═'.repeat(59)}${C.nc}`;
  console.log(line);
  console.log(`${C.green}  ${msg}${C.nc}`);
  console.log(line);
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Parse .env file into process.env (no external dependency). */
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writePid(name, pid) {
  ensureDir(PID_DIR);
  fs.writeFileSync(path.join(PID_DIR, `${name}.pid`), String(pid));
}

function readPid(name) {
  const file = path.join(PID_DIR, `${name}.pid`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').trim();
  return raw ? Number(raw) : null;
}

function removePid(name) {
  const file = path.join(PID_DIR, `${name}.pid`);
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

function isRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Wait ms milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve the npm executable for spawning. On Windows `npm` isn't directly
 *  executable via spawn without shell, so we use `{ shell: true }`. */
function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Make a quick HTTP GET and resolve with the body string (or null on error). */
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Run a command synchronously and return stdout (or null on failure). */
function runSync(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
  } catch { return null; }
}

/** Get the resolved database path from DATABASE_URL. */
function getDbPath() {
  const raw = process.env.DATABASE_URL || '';
  const relative = raw.replace(/^file:/, '');
  // DATABASE_URL is relative to the prisma/ directory
  return path.resolve(PROJECT_ROOT, 'prisma', relative);
}

/** Get the LanceDB data path. */
function getLanceDbPath() {
  return path.resolve(PROJECT_ROOT, process.env.LANCEDB_PATH || './data/lancedb');
}

// ── Commands ───────────────────────────────────────────────────────────────

// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
// start [dev|production]
// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
async function cmdStart(mode = 'dev') {
  info(`Starting Sound Suite in ${mode} mode...`);
  console.log();

  // Ensure .env exists
  if (!fs.existsSync(ENV_FILE)) {
    err('.env file not found!');
    info('Please copy .env.example to .env and configure it.');
    process.exit(1);
  }
  loadEnv();

  // Ensure directories
  ensureDir(PID_DIR);
  ensureDir(LOG_DIR);

  // Check for already-running services
  const dashPid = readPid('dashboard');
  if (dashPid && isRunning(dashPid)) {
    err(`Dashboard is already running (PID: ${dashPid})`);
    info('Please stop existing services first: npm run svc:stop');
    process.exit(1);
  }

  // Database — run migrations if needed
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    info('Database not found — running prisma migrate deploy...');
    runSync(`npx prisma migrate deploy`);
    ok('Database created and migrations applied');
  } else {
    ok(`Database found at ${dbPath}`);
  }
  console.log();

  // Spawn Next.js
  info(`Starting Next.js (${mode})...`);
  const logFile = path.join(LOG_DIR, 'dashboard.log');
  const logFd = fs.openSync(logFile, 'a');

  const npmScript = mode === 'production' ? 'start' : 'dev';

  // For production, build first
  if (mode === 'production') {
    info('Building Next.js for production...');
    try {
      execSync(`${npmCmd()} run build`, { cwd: PROJECT_ROOT, stdio: 'inherit' });
    } catch {
      err('Build failed');
      process.exit(1);
    }
  }

  const child = spawn(npmCmd(), ['run', npmScript], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    shell: process.platform === 'win32',
  });

  child.unref();
  writePid('dashboard', child.pid);
  fs.closeSync(logFd);

  // Wait for process to settle
  await sleep(3000);

  if (!isRunning(child.pid)) {
    err('Dashboard failed to start');
    info(`Check logs at: ${logFile}`);
    process.exit(1);
  }

  ok(`Dashboard started (PID: ${child.pid})`);
  console.log();

  // Health check
  info('Running health check...');
  await sleep(2000);
  const body = await httpGet('http://localhost:3000/api/health');
  if (body) {
    ok('Dashboard health check passed');
  } else {
    warn('Dashboard not responding yet (may still be starting)');
    info(`Run 'npm run svc:health' to check later.`);
  }

  console.log();
  banner('Sound Suite Started Successfully!');
  console.log();
  info('Service Status:');
  console.log(`  • Dashboard:     Running (PID: ${child.pid})`);
  console.log('  • File Watcher:  Integrated with dashboard');
  console.log('  • Job Queue:     Integrated with dashboard');
  console.log('  • MCP Server:    Integrated with dashboard');
  console.log();
  info('Access Points:');
  console.log('  • Dashboard:     http://localhost:3000');
  console.log(`  • MCP Server:    http://localhost:${process.env.MCP_PORT || 3001}`);
  console.log();
  info('Management:');
  console.log('  • Stop services:  npm run svc:stop');
  console.log('  • Restart:        npm run svc:restart');
  console.log('  • Health check:   npm run svc:health');
  console.log();
}

// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
// stop
// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
async function cmdStop() {
  info('Stopping Sound Suite services...');
  console.log();

  if (!fs.existsSync(PID_DIR)) {
    warn('PID directory not found — no services appear to be running');
    return;
  }

  const services = ['dashboard', 'mcp-server', 'job-queue', 'file-watcher'];

  // Discover worker PID files too
  try {
    for (const f of fs.readdirSync(PID_DIR)) {
      if (f.startsWith('worker-') && f.endsWith('.pid')) {
        services.push(f.replace('.pid', ''));
      }
      if (f === 'daemon.pid') services.push('daemon');
    }
  } catch { /* ignore */ }

  let allStopped = true;

  for (const svc of services) {
    const pid = readPid(svc);
    if (!pid) { removePid(svc); continue; }
    if (!isRunning(pid)) {
      warn(`${svc}: Process not running (stale PID: ${pid})`);
      removePid(svc);
      continue;
    }

    info(`${svc}: Stopping process (PID: ${pid})...`);

    try { process.kill(pid, 'SIGTERM'); } catch {
      err(`${svc}: Failed to send SIGTERM`);
      removePid(svc);
      allStopped = false;
      continue;
    }

    // Wait up to 10 seconds
    let stopped = false;
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      if (!isRunning(pid)) { stopped = true; break; }
    }

    if (!stopped) {
      warn(`${svc}: Sending SIGKILL...`);
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      await sleep(1000);
      if (isRunning(pid)) {
        err(`${svc}: Failed to stop process`);
        allStopped = false;
        continue;
      }
    }

    ok(`${svc}: Stopped successfully`);
    removePid(svc);
  }

  // Clean up PID directory
  try {
    const remaining = fs.readdirSync(PID_DIR);
    if (remaining.length === 0) fs.rmdirSync(PID_DIR);
  } catch { /* ignore */ }

  // Remove stale Next.js cache lock
  const lockFile = path.join(PROJECT_ROOT, '.next', 'cache', 'lock');
  try { fs.unlinkSync(lockFile); } catch { /* ignore */ }

  console.log();
  if (allStopped) {
    banner('Sound Suite Stopped Successfully!');
    console.log();
    info('All services have been stopped and cleaned up');
  } else {
    err('Some services failed to stop');
    info(`Check running processes manually.`);
    process.exit(1);
  }
}

// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
// restart [mode]
// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
async function cmdRestart(mode = 'dev') {
  banner('Sound Suite — Restart Services');
  console.log();

  info('Step 1: Stopping all services...');
  await cmdStop();

  info('Waiting for clean shutdown...');
  await sleep(2000);
  console.log();

  info('Step 2: Starting all services...');
  await cmdStart(mode);
}

// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
// health
// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
async function cmdHealth() {
  loadEnv();

  banner('Sound Suite Health Check');
  console.log();
  info(`Checking system health at ${new Date().toISOString()}`);
  console.log();

  let allHealthy = true;

  // Dashboard
  const dashPid = readPid('dashboard');
  if (dashPid && isRunning(dashPid)) {
    ok(`Dashboard: Running (PID: ${dashPid})`);
  } else {
    // Try HTTP fallback
    const body = await httpGet('http://localhost:3000/api/health');
    if (body) {
      ok('Dashboard: Running (responding on http://localhost:3000)');
    } else {
      warn('Dashboard: Not running');
      allHealthy = false;
    }
  }

  // HTTP health endpoint
  const healthBody = await httpGet('http://localhost:3000/api/health');
  if (healthBody) {
    try {
      const data = JSON.parse(healthBody);
      const services = data.services || data;
      for (const [name, svc] of Object.entries(services)) {
        const status = typeof svc === 'object' && svc !== null ? svc.status : svc;
        if (status === 'running' || status === 'healthy') {
          ok(`  ${name}: ${status}`);
        } else {
          warn(`  ${name}: ${status || 'unknown'}`);
          allHealthy = false;
        }
      }
    } catch {
      ok('Health endpoint responded (could not parse details)');
    }
  } else {
    warn('Health endpoint not reachable');
    allHealthy = false;
  }
  console.log();

  // Database file
  const dbPath = getDbPath();
  if (fs.existsSync(dbPath)) {
    const stats = fs.statSync(dbPath);
    const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
    ok(`Database: ${sizeMb} MB (${dbPath})`);
  } else {
    warn(`Database file not found at ${dbPath}`);
    allHealthy = false;
  }

  // LanceDB
  const lancePath = getLanceDbPath();
  if (fs.existsSync(lancePath) && fs.statSync(lancePath).isDirectory()) {
    ok(`LanceDB: Directory exists (${lancePath})`);
  } else {
    warn(`LanceDB: Directory not found at ${lancePath}`);
  }

  console.log();
  if (allHealthy) {
    ok('System Status: HEALTHY');
  } else {
    warn('System Status: DEGRADED');
    process.exit(1);
  }
}

// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
// db:migrate
// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
function cmdDbMigrate() {
  loadEnv();

  banner('Sound Suite — Database Migration');
  console.log();

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    info('Database not found — creating with migrations...');
  } else {
    ok(`Database found at ${dbPath}`);
  }

  info('Running prisma migrate deploy...');
  try {
    execSync('npx prisma migrate deploy', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    ok('Migrations applied successfully');
  } catch {
    err('Migration failed');
    process.exit(1);
  }
}

// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
// db:backup [--output dir]
// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
function cmdDbBackup(args) {
  loadEnv();

  banner('Sound Suite — Database Backup');
  console.log();

  let outputDir = path.join(PROJECT_ROOT, 'data', 'backups');
  const outputIdx = args.indexOf('--output');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    outputDir = path.resolve(args[outputIdx + 1]);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupDir = path.join(outputDir, `backup-${timestamp}`);
  ensureDir(backupDir);

  const dbPath = getDbPath();
  const lancePath = getLanceDbPath();

  // Backup SQLite
  if (fs.existsSync(dbPath)) {
    const dest = path.join(backupDir, 'sound-suite.db');
    fs.copyFileSync(dbPath, dest);
    const sizeMb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
    ok(`SQLite backed up: ${sizeMb} MB`);
  } else {
    warn(`Database file not found at ${dbPath}`);
  }

  // Backup LanceDB
  if (fs.existsSync(lancePath)) {
    copyDirSync(lancePath, path.join(backupDir, 'lancedb'));
    ok('LanceDB backed up');
  } else {
    warn(`LanceDB directory not found at ${lancePath}`);
  }

  // Manifest
  const manifest = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    databasePath: dbPath,
    lancedbPath: lancePath,
    backupType: 'full',
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  ok(`Manifest created`);

  console.log();
  ok(`Backup saved to: ${backupDir}`);
}

/** Recursively copy a directory. */
function copyDirSync(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
// db:restore <backup-dir>
// ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
function cmdDbRestore(args) {
  loadEnv();

  const backupDir = args[0];
  if (!backupDir || !fs.existsSync(backupDir)) {
    err('Usage: node scripts/manage.mjs db:restore <backup-dir>');
    if (backupDir) err(`Directory not found: ${backupDir}`);
    process.exit(1);
  }

  const manifestFile = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    err('No manifest.json found — not a valid backup directory');
    process.exit(1);
  }

  banner('Sound Suite — Database Restore');
  console.log();
  warn('This will OVERWRITE current database data!');
  console.log();

  const dbPath = getDbPath();
  const lancePath = getLanceDbPath();

  // Pre-restore backup of current data
  const preBackup = path.join(PROJECT_ROOT, 'data', 'backups',
    `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  ensureDir(preBackup);
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, path.join(preBackup, 'sound-suite.db'));
    info(`Current database backed up to ${preBackup}`);
  }

  // Restore SQLite
  const backupDb = path.join(backupDir, 'sound-suite.db');
  if (fs.existsSync(backupDb)) {
    ensureDir(path.dirname(dbPath));
    fs.copyFileSync(backupDb, dbPath);
    ok('SQLite database restored');
  } else {
    warn('No sound-suite.db in backup — skipping SQLite restore');
  }

  // Restore LanceDB
  const backupLance = path.join(backupDir, 'lancedb');
  if (fs.existsSync(backupLance)) {
    // Remove existing and copy
    if (fs.existsSync(lancePath)) {
      fs.rmSync(lancePath, { recursive: true, force: true });
    }
    copyDirSync(backupLance, lancePath);
    ok('LanceDB data restored');
  } else {
    warn('No lancedb/ in backup — skipping LanceDB restore');
  }

  console.log();
  ok('Restore complete');
  info(`Pre-restore backup saved at: ${preBackup}`);
  info('Start services: npm run svc:start');
}

// ── CLI Router ─────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'start':
    await cmdStart(args[0] === 'production' || args[0] === 'prod' ? 'production' : 'dev');
    break;
  case 'stop':
    await cmdStop();
    break;
  case 'restart':
    await cmdRestart(args[0] === 'production' || args[0] === 'prod' ? 'production' : 'dev');
    break;
  case 'health':
    await cmdHealth();
    break;
  case 'db:migrate':
    cmdDbMigrate();
    break;
  case 'db:backup':
    cmdDbBackup(args);
    break;
  case 'db:restore':
    cmdDbRestore(args);
    break;
  default:
    console.log(`
Sound Suite — Cross-Platform Process Manager

Usage: node scripts/manage.mjs <command> [options]

Commands:
  start [dev|production]    Start Sound Suite (default: dev)
  stop                      Stop all services
  restart [dev|production]  Restart all services
  health                    Check service health

  db:migrate                Run prisma migrate deploy
  db:backup [--output dir]  Backup SQLite + LanceDB
  db:restore <backup-dir>   Restore from backup
`);
    process.exit(command ? 1 : 0);
}
