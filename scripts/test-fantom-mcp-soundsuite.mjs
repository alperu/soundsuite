#!/usr/bin/env node
/**
 * Fantom MCP — SoundSuite test harness.
 *
 * Spawns the fantom-mcp stdio server, drives it through the same probe
 * sequence the human-in-the-loop reports use, and prints a compact
 * pass/fail summary plus the raw responses for each step.
 *
 * Usage:
 *   node scripts/test-fantom-mcp-soundsuite.mjs            # default: all probes
 *   node scripts/test-fantom-mcp-soundsuite.mjs --raw      # also dump raw JSON
 *   PROJECT_NAME=SoundSuite node scripts/...               # override project
 *
 * No external deps — talks raw JSON-RPC 2.0 over stdio.
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER_BIN = process.env.FANTOM_MCP_BIN ||
  '/Users/alper/Code/mcpfantom/build/index.js';
const DATABASE_URL = process.env.DATABASE_URL ||
  'file:/Users/alper/Code/mcpfantom/.cache/fantom.db';
const PROJECT_NAME = process.env.PROJECT_NAME || 'SoundSuite';
const PROJECT_PATH = process.env.PROJECT_PATH ||
  '/Users/alper/Code/court-lens-mcp';
const SHOW_RAW = process.argv.includes('--raw');

// Files we expect to find real symbols in (override via env).
const PROBE_FILE = process.env.PROBE_FILE ||
  `${PROJECT_PATH}/src/lib/ingestion/ingestion-pipeline.ts`;

function nowIso() { return new Date().toISOString(); }

class StdioClient {
  constructor(cmd, args, env) {
    this.proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', () => {}); // ignore server logs
    this.proc.on('exit', (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`server exited ${code}`));
      }
    });
  }
  _onStdout(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }
  send(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 60_000);
    });
  }
  notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }
  async close() {
    this.proc.stdin.end();
    await new Promise((r) => this.proc.on('exit', r));
  }
}

async function callTool(client, name, args = {}) {
  const resp = await client.send('tools/call', { name, arguments: args });
  if (resp.error) {
    return { ok: false, error: resp.error };
  }
  // tools/call result.content[0].text holds JSON for fantom-mcp tools.
  const content = resp.result?.content?.[0];
  if (content?.type === 'text') {
    try { return { ok: true, data: JSON.parse(content.text) }; }
    catch { return { ok: true, data: content.text }; }
  }
  return { ok: true, data: resp.result };
}

function summarize(label, ok, detail) {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${label.padEnd(40)} ${detail}`);
}

async function main() {
  console.log(`Fantom MCP test — ${nowIso()}`);
  console.log(`server: ${SERVER_BIN}`);
  console.log(`project: ${PROJECT_NAME} @ ${PROJECT_PATH}\n`);

  const client = new StdioClient('node', [SERVER_BIN], { DATABASE_URL });

  // Initialize.
  const init = await client.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'soundsuite-test-harness', version: '1' },
  });
  if (init.error) {
    console.error('initialize failed:', init.error);
    await client.close();
    process.exit(2);
  }
  client.notify('notifications/initialized', {});
  await delay(100);

  const raw = {};

  // 1. searchProjects
  const sp = await callTool(client, 'searchProjects', { query: PROJECT_NAME });
  raw.searchProjects = sp;
  const proj = sp.data?.projects?.[0];
  const projectId = proj?.id;
  summarize('searchProjects', !!proj,
    proj ? `id=${proj.id} fns=${proj.functionCount} types=${proj.typeCount}`
         : 'project not found');
  if (!projectId) { await client.close(); process.exit(1); }

  // 2. getIndexHealth
  const hl = await callTool(client, 'getIndexHealth', { projectId });
  raw.getIndexHealth = hl;
  const h = hl.data || {};
  summarize('getIndexHealth.prisma',
    (h.prisma?.functions ?? 0) > 0,
    `fns=${h.prisma?.functions} types=${h.prisma?.types}`);
  summarize('getIndexHealth.flexsearch',
    (h.flexsearch?.symbols ?? 0) >= (h.prisma?.functions ?? 0),
    `symbols=${h.flexsearch?.symbols} (Prisma=${h.prisma?.functions})`);
  summarize('getIndexHealth.ladybug',
    (h.ladybug?.nodes ?? 0) > 0,
    `nodes=${h.ladybug?.nodes} edges=${h.ladybug?.edges}`);
  summarize('getIndexHealth.lance',
    (h.lance?.vectors ?? 0) > 0,
    `vectors=${h.lance?.vectors} coverage=${h.lance?.coverage}`);
  summarize('getIndexHealth.indexRun', !!h.indexRun,
    h.indexRun
      ? `latestId=${h.indexRun.latestId} trigger=${h.indexRun.trigger}`
      : 'null (IndexRun not persisted)');
  for (const w of h.warnings || []) console.log('   ⚠️ ', w);

  // 3. searchFantomCode (real-source keywords) — use projectName because
  // projectId filter has historically been broken.
  for (const q of ['classify', 'ingest', 'async']) {
    const r = await callTool(client, 'searchFantomCode',
      { query: q, projectName: PROJECT_NAME, limit: 3 });
    raw[`search:${q}`] = r;
    const n = r.data?.resultsFound ?? 0;
    summarize(`searchFantomCode("${q}")`, n > 0, `hits=${n}`);
  }

  // 4. semanticCodeSearch
  const sem = await callTool(client, 'semanticCodeSearch', {
    query: 'PDF document ingestion pipeline',
    projectName: PROJECT_NAME, limit: 3,
  });
  raw.semanticCodeSearch = sem;
  const semHits = Array.isArray(sem.data?.results) ? sem.data.results.length : 0;
  summarize('semanticCodeSearch', semHits > 0, `hits=${semHits}`);

  // 5. listFunctionsInFile
  const lff = await callTool(client, 'listFunctionsInFile',
    { filePath: PROBE_FILE, projectId, limit: 5 });
  raw.listFunctionsInFile = lff;
  summarize('listFunctionsInFile', (lff.data?.total ?? 0) > 0,
    `total=${lff.data?.total} file=${PROBE_FILE.split('/').pop()}`);

  // 6. refreshFantomProject — should be a no-op when nothing changed.
  const rf = await callTool(client, 'refreshFantomProject', { projectId });
  raw.refreshFantomProject = rf;
  const idx = rf.data?.indexResult || {};
  summarize('refreshFantomProject',
    rf.ok && (idx.errors ?? 0) === 0,
    `fns=${idx.functionsIndexed} types=${idx.typesIndexed} files=${idx.filesProcessed} dur=${idx.duration}ms`);

  // 7. health post-refresh — must not regress Prisma.
  const hl2 = await callTool(client, 'getIndexHealth', { projectId });
  raw.getIndexHealthPostRefresh = hl2;
  const h2 = hl2.data || {};
  const stable = (h2.prisma?.functions ?? -1) === (h.prisma?.functions ?? 0);
  summarize('refresh did not regress Prisma', stable,
    `before=${h.prisma?.functions} after=${h2.prisma?.functions}`);

  // 8. whatChangedRecently
  const wc = await callTool(client, 'whatChangedRecently',
    { projectId, hoursAgo: 24 });
  raw.whatChangedRecently = wc;
  const totalChanges = wc.data?.totalChanges ?? 0;
  summarize('whatChangedRecently', totalChanges > 0,
    `totalChanges=${totalChanges}`);

  // 9. listIndexRuns
  const lr = await callTool(client, 'listIndexRuns', { projectId, limit: 5 });
  raw.listIndexRuns = lr;
  summarize('listIndexRuns', (lr.data?.count ?? 0) > 0,
    `count=${lr.data?.count}`);

  if (SHOW_RAW) {
    console.log('\n--- raw responses ---');
    console.log(JSON.stringify(raw, null, 2));
  }

  await client.close();
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(2);
});
