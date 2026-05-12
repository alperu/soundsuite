import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { state, ensureMaster, syncLegacyServerUrl } from './state';
import { createLogger } from './logger';
import { loadSidecarConfig, saveSidecarConfig } from './sidecar-config';

const log = createLogger('config');

const CONFIG_PATH = process.env.CONFIG_PATH ||
  path.join(path.dirname(process.argv[1] || __filename), 'config', 'config.json');

const RECENT_MASTERS_PATH = process.env.RECENT_MASTERS_PATH ||
  path.join(path.dirname(CONFIG_PATH), 'recent-masters.json');

interface MasterEntry { serverUrl: string; authToken?: string; wsPort?: number }

function parseMastersField(raw: unknown): MasterEntry[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out: MasterEntry[] = [];
    for (const item of raw) {
      if (typeof item === 'string' && item) out.push({ serverUrl: item });
      else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.serverUrl === 'string' && obj.serverUrl) {
          const entry: MasterEntry = { serverUrl: obj.serverUrl };
          if (typeof obj.authToken === 'string') entry.authToken = obj.authToken;
          if (typeof obj.wsPort === 'number' && obj.wsPort > 0) entry.wsPort = obj.wsPort;
          out.push(entry);
        }
      }
    }
    return out;
  }
  return [];
}

export function loadSavedConfig(): Record<string, unknown> | null {
  log.info(`Config path: ${CONFIG_PATH} (exists: ${fs.existsSync(CONFIG_PATH)})`);
  let data: Record<string, unknown> | null = null;

  // Boot-time priority: config.json → sidecar.config.json → SIDECAR_MASTERS env.
  // Whichever source the master most recently pushed via `master-identity` (WS),
  // `X-Sound-Suite-Master-Url` (HTTP), or POST /api/masters (reverse-poll) is the
  // highest-priority anchor: it lives in config.json (written by saveConfig()).
  // All pushed URLs are merged additively — an operator can still manually add
  // entries via the UI, and old masters that never push an identity continue to
  // work via the legacy fallback chain.
  // Collect master URLs from all sources, deduped (insertion order = priority).
  const collected = new Map<string, MasterEntry>();
  const addMaster = (e: MasterEntry) => {
    if (!e.serverUrl) return;
    const existing = collected.get(e.serverUrl);
    if (existing) {
      if (e.authToken && !existing.authToken) existing.authToken = e.authToken;
      if (e.wsPort !== undefined && existing.wsPort === undefined) existing.wsPort = e.wsPort;
    } else {
      collected.set(e.serverUrl, { ...e });
    }
  };

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;

      // Multi-master field (preferred, new)
      for (const e of parseMastersField(data.masters)) addMaster(e);

      // Legacy single-master field
      if (typeof data.serverUrl === 'string' && data.serverUrl) {
        addMaster({ serverUrl: data.serverUrl });
      }

      if (data.idleTimeouts) {
        Object.assign(state.idleTimeouts, data.idleTimeouts);
        log.info('Loaded saved idle timeouts', state.idleTimeouts);
      }
      if (data.minOnline) {
        Object.assign(state.minOnline, data.minOnline);
        log.info('Loaded saved minOnline', state.minOnline);
      }
      if (data.mode) {
        state.currentMode = data.mode as 'indexing' | 'searching';
        log.info(`Loaded saved mode: ${state.currentMode}`);
      }
      if (data.agentUrl) {
        state.savedAgentUrl = data.agentUrl as string;
        log.info(`Loaded saved agent URL: ${state.savedAgentUrl}`);
      }
      if (data.registry) {
        for (const [role, overrides] of Object.entries(data.registry as Record<string, unknown>)) {
          if (state.registry[role]) Object.assign(state.registry[role], overrides);
        }
        log.info('Loaded saved registry overrides');
      }
      // Migrate stale OCR model name (community model requires namespace prefix)
      if (state.registry.ocr?.model === 'olmocr2:7b-q8') {
        state.registry.ocr.model = 'richardyoung/olmocr2:7b-q8';
        log.info('Migrated OCR model name: olmocr2:7b-q8 → richardyoung/olmocr2:7b-q8');
      }
    } else {
      log.info(`config.json not found at ${CONFIG_PATH} — falling back to sidecar.config.json`);
    }
  } catch (err) {
    log.error(`Failed to load config.json: ${(err as Error).message} — falling back to sidecar.config.json`);
  }

  // sidecar.config.json — secondary source, kept for back-compat (single URL).
  try {
    const sidecarConfig = loadSidecarConfig();
    if (sidecarConfig?.serverUrl) {
      addMaster({ serverUrl: sidecarConfig.serverUrl });
      log.info(`Loaded serverUrl from sidecar.config.json: ${sidecarConfig.serverUrl}`);
    }
  } catch (err) {
    log.error(`Failed to load sidecar.config.json: ${(err as Error).message}`);
  }

  // Env: SIDECAR_MASTERS (comma list, NEW), SOUND_SUITE_MASTER_URL, SERVER_URL.
  // Per-token syntax: "<url>" or "<url>|<wsPort>" — pipe lets ops override
  // the default 3002 for masters that consolidate WS+HTTP on one port.
  const envList = process.env.SIDECAR_MASTERS;
  if (envList) {
    for (const tok of envList.split(',').map(s => s.trim()).filter(Boolean)) {
      const [url, wsPortStr] = tok.split('|');
      const wsPort = wsPortStr ? Number(wsPortStr) : undefined;
      addMaster({ serverUrl: url, wsPort: Number.isFinite(wsPort) && wsPort! > 0 ? wsPort : undefined });
    }
    log.info(`Loaded masters from SIDECAR_MASTERS env: ${envList}`);
  }
  const envUrl = process.env.SOUND_SUITE_MASTER_URL || process.env.SERVER_URL;
  if (envUrl) {
    addMaster({ serverUrl: envUrl });
    const which = process.env.SOUND_SUITE_MASTER_URL ? 'SOUND_SUITE_MASTER_URL' : 'SERVER_URL';
    log.info(`Loaded serverUrl from ${which} env: ${envUrl}`);
  }

  // Populate state.masters
  for (const entry of collected.values()) {
    ensureMaster(entry.serverUrl, { authToken: entry.authToken, wsPort: entry.wsPort });
  }
  syncLegacyServerUrl();

  if (state.masters.size === 0) {
    log.info('No masters configured (config.json, sidecar.config.json, SIDECAR_MASTERS, SOUND_SUITE_MASTER_URL/SERVER_URL all empty) — fresh start');
  } else {
    log.info(`Configured masters: ${[...state.masters.keys()].join(', ')}`);
  }

  return data;
}

export function saveConfig(): void {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const masters = [...state.masters.values()].map((m) => {
      const entry: { serverUrl: string; authToken?: string; wsPort?: number } = {
        serverUrl: m.serverUrl,
      };
      if (m.authToken) entry.authToken = m.authToken;
      if (m.wsPort) entry.wsPort = m.wsPort;
      return entry;
    });
    const firstUrl = masters.length > 0 ? masters[0].serverUrl : null;
    const data = {
      // Canonical multi-master field
      masters,
      // Legacy single-URL field — kept so older parsers still work.
      serverUrl: firstUrl,
      agentUrl: state.savedAgentUrl,
      idleTimeouts: state.idleTimeouts,
      minOnline: state.minOnline,
      mode: state.currentMode,
      registry: Object.fromEntries(
        Object.entries(state.registry).map(([role, def]) => [role, { model: def.model, port: def.port }]),
      ),
    };
    // Atomic write: write-temp-then-rename so a crash/kill during write
    // produces either the OLD valid file or the NEW valid file — never a
    // 0-byte corrupted config that would wipe masters on next boot.
    // rename(2) is atomic within the same filesystem on POSIX. On Windows
    // it's effectively atomic for our purposes (single-writer, no readers
    // racing). We fsync the temp file before rename to survive a kernel
    // panic / power loss between write() and the on-disk flush.
    const tmp = `${CONFIG_PATH}.tmp.${process.pid}`;
    const payload = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, payload);
      try { fs.fsyncSync(fd); } catch { /* fsync not supported on some FS — best effort */ }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, CONFIG_PATH);
    log.info(`Config saved to ${CONFIG_PATH} (masters=${masters.length}, first=${firstUrl}, agentUrl=${data.agentUrl})`);

    // Mirror first master URL into sidecar.config.json for back-compat.
    if (firstUrl) {
      try {
        saveSidecarConfig({ serverUrl: firstUrl });
      } catch (err) {
        log.warn(`Could not mirror to sidecar.config.json: ${(err as Error).message}`);
      }
    }

    // Channel 4 hint file: mirror master URLs into a tiny sidecar file that
    // survives operator `Remove` actions and can re-seed discovery on a
    // fresh container with anonymous volume. Best-effort, never fatal.
    try {
      saveRecentMasters(masters);
    } catch (err) {
      log.warn(`Could not save recent-masters.json: ${(err as Error).message}`);
    }
  } catch (err) {
    log.error(`Failed to save config to ${CONFIG_PATH}: ${(err as Error).message}`);
    // Best-effort cleanup of orphaned temp file from a failed atomic write.
    try {
      const tmp = `${CONFIG_PATH}.tmp.${process.pid}`;
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch { /* ignore */ }
  }
}

/** Return the resolved config file path for diagnostics. */
export function getConfigPath(): string { return CONFIG_PATH; }

// ─── Recent-masters hint file (Channel 4) ────────────────────────────────
// Survives `config.json` wipe and operator-`Remove` so a rebooted container
// with an anonymous volume can still re-find a previously-known master.

interface RecentMasterEntry {
  serverUrl: string;
  wsPort?: number;
  lastSeenAt: number; // epoch ms
}

function saveRecentMasters(currentMasters: { serverUrl: string; wsPort?: number }[]): void {
  if (!currentMasters.length) return;
  let prior: RecentMasterEntry[] = [];
  try { prior = loadRecentMasters(); } catch { /* ignore */ }

  const merged = new Map<string, RecentMasterEntry>();
  // Replay prior first so it's overridden by anything we just saved.
  for (const e of prior) merged.set(e.serverUrl, e);
  const now = Date.now();
  for (const m of currentMasters) {
    merged.set(m.serverUrl, { serverUrl: m.serverUrl, wsPort: m.wsPort, lastSeenAt: now });
  }
  // Cap at 8 most-recently-seen, keep file tiny.
  const sorted = [...merged.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 8);

  const dir = path.dirname(RECENT_MASTERS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${RECENT_MASTERS_PATH}.tmp.${process.pid}`;
  const payload = JSON.stringify({ masters: sorted }, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, payload);
    try { fs.fsyncSync(fd); } catch { /* fsync optional */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, RECENT_MASTERS_PATH);
}

export function loadRecentMasters(): RecentMasterEntry[] {
  try {
    if (!fs.existsSync(RECENT_MASTERS_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(RECENT_MASTERS_PATH, 'utf8')) as Record<string, unknown>;
    const arr = Array.isArray(raw.masters) ? raw.masters : [];
    const out: RecentMasterEntry[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.serverUrl !== 'string' || !obj.serverUrl) continue;
      const entry: RecentMasterEntry = {
        serverUrl: obj.serverUrl,
        lastSeenAt: typeof obj.lastSeenAt === 'number' ? obj.lastSeenAt : 0,
      };
      if (typeof obj.wsPort === 'number' && obj.wsPort > 0) entry.wsPort = obj.wsPort;
      out.push(entry);
    }
    return out;
  } catch (err) {
    log.warn(`loadRecentMasters: ${(err as Error).message}`);
    return [];
  }
}

// ─── Boot-time master discovery (Channels 2–5) ───────────────────────────
// Triggered from instrumentation.ts AFTER loadSavedConfig() when state.masters
// is still empty. Each channel is best-effort; failures never propagate.

const PROBE_TIMEOUT_MS = 2_000;
const COMMON_PORTS = [3000, 3300];

/** GET <url> with a tight timeout. Resolves with status + body; never throws. */
function httpGetWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve(null); return; }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': 'sound-suite-sidecar-discovery/1' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; if (data.length > 4096) { data = data.slice(0, 4096); req.destroy(); } });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        res.on('error', () => resolve(null));
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Return true iff `baseUrl` looks like a Sound Suite / Fantom MCP master.
 *  Strategy:
 *   1. /api/health 200 with a body containing 'overall' or 'service' or 'sound-suite' / 'fantom'.
 *   2. Fallback: /api/admin/gpu-fleet 200 OR 401 (sound-suite-only endpoint).
 */
async function probeIsMaster(baseUrl: string): Promise<boolean> {
  const health = await httpGetWithTimeout(`${baseUrl}/api/health`, PROBE_TIMEOUT_MS);
  if (health && health.status === 200) {
    const body = health.body.toLowerCase();
    if (body.includes('"overall"') || body.includes('"service"') ||
        body.includes('sound-suite') || body.includes('fantom') ||
        body.includes('"filewatcher"') || body.includes('"mcp"')) {
      return true;
    }
  }
  // gpu-fleet is a sound-suite-distinctive endpoint; 401 also counts ("looks like").
  const fleet = await httpGetWithTimeout(`${baseUrl}/api/admin/gpu-fleet`, PROBE_TIMEOUT_MS);
  if (fleet && (fleet.status === 200 || fleet.status === 401)) return true;
  return false;
}

/** Parse the default-gateway IP from /proc/net/route. Linux only. Best-effort. */
function readDefaultGatewayV4(): string | null {
  try {
    const raw = fs.readFileSync('/proc/net/route', 'utf8');
    const lines = raw.split('\n');
    // Skip header. Each line: Iface  Destination  Gateway  Flags ...
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 3) continue;
      // Destination 00000000 = default route. Hex little-endian.
      if (parts[1] === '00000000' && parts[2] && parts[2].length === 8) {
        const hex = parts[2];
        // Little-endian → reverse byte order
        const b1 = parseInt(hex.slice(6, 8), 16);
        const b2 = parseInt(hex.slice(4, 6), 16);
        const b3 = parseInt(hex.slice(2, 4), 16);
        const b4 = parseInt(hex.slice(0, 2), 16);
        if ([b1, b2, b3, b4].some(n => Number.isNaN(n))) continue;
        return `${b1}.${b2}.${b3}.${b4}`;
      }
    }
  } catch { /* /proc not present (non-Linux) — fine */ }
  return null;
}

interface DiscoveryCandidate {
  baseUrl: string;
  source: string;
}

function dedupeCandidates(cands: DiscoveryCandidate[]): DiscoveryCandidate[] {
  const seen = new Set<string>();
  const out: DiscoveryCandidate[] = [];
  for (const c of cands) {
    const key = c.baseUrl.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ baseUrl: key, source: c.source });
  }
  return out;
}

/**
 * Multi-channel boot-time master discovery. Call when loadSavedConfig() left
 * state.masters empty. Probes a bounded set of likely master URLs in parallel
 * (each with a 2s timeout) and registers any that reply with a Sound Suite /
 * Fantom MCP signature. Bounded wall-clock by Promise.allSettled.
 *
 * Returns the list of URLs that were registered (may be empty).
 */
export async function discoverMasters(): Promise<string[]> {
  if (state.masters.size > 0) {
    log.info('discoverMasters: state.masters already populated, skipping');
    return [];
  }
  if (process.env.SS_DISCOVERY_DISABLED === '1') {
    log.info('discoverMasters: disabled via SS_DISCOVERY_DISABLED=1');
    return [];
  }

  const candidates: DiscoveryCandidate[] = [];

  // Channel 4 — recent-masters hint file (operator removed but volume kept).
  try {
    for (const e of loadRecentMasters()) {
      candidates.push({ baseUrl: e.serverUrl, source: 'recent-masters.json' });
    }
  } catch (err) {
    log.warn(`recent-masters channel failed: ${(err as Error).message}`);
  }

  // Channel 2 — host.docker.internal (Mac/Windows Docker Desktop).
  for (const port of COMMON_PORTS) {
    candidates.push({ baseUrl: `http://host.docker.internal:${port}`, source: 'host.docker.internal' });
  }

  // Channel 3 — LAN default gateway (Linux Docker bridge).
  const gateway = readDefaultGatewayV4();
  if (gateway) {
    for (const port of COMMON_PORTS) {
      candidates.push({ baseUrl: `http://${gateway}:${port}`, source: `gateway(${gateway})` });
    }
  }

  // Channel 5 — SIDECAR_MASTER_HOSTS env hint (hostnames or IPs).
  const hostList = process.env.SIDECAR_MASTER_HOSTS;
  if (hostList) {
    for (const tok of hostList.split(',').map(s => s.trim()).filter(Boolean)) {
      // Accept "host" or "host:port" — fan out across common ports if no port.
      if (/:\d+$/.test(tok)) {
        candidates.push({ baseUrl: `http://${tok}`, source: 'SIDECAR_MASTER_HOSTS' });
      } else {
        for (const port of COMMON_PORTS) {
          candidates.push({ baseUrl: `http://${tok}:${port}`, source: 'SIDECAR_MASTER_HOSTS' });
        }
      }
    }
  }

  const deduped = dedupeCandidates(candidates);
  if (deduped.length === 0) {
    log.info('discoverMasters: no candidates to probe');
    return [];
  }

  log.info(`discoverMasters: probing ${deduped.length} candidate(s) (sources: ${[...new Set(deduped.map(c => c.source))].join(', ')})`);

  // Probe all candidates in parallel — bounded by PROBE_TIMEOUT_MS * 2 (health + fleet).
  const probes = deduped.map(async (c) => {
    try {
      const ok = await probeIsMaster(c.baseUrl);
      return { c, ok };
    } catch {
      return { c, ok: false };
    }
  });
  const results = await Promise.allSettled(probes);

  const found: string[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value.ok) continue;
    const { c } = r.value;
    if (state.masters.has(c.baseUrl)) continue;
    try {
      ensureMaster(c.baseUrl, {});
      found.push(c.baseUrl);
      log.info(`Master discovered via ${c.source}: ${c.baseUrl}`);
    } catch (err) {
      log.warn(`ensureMaster failed for discovered "${c.baseUrl}": ${(err as Error).message}`);
    }
  }

  if (found.length) {
    syncLegacyServerUrl();
    try { saveConfig(); } catch (err) { log.warn(`saveConfig after discovery failed: ${(err as Error).message}`); }
  } else {
    log.info('discoverMasters: no master responded to probes — sidecar remains unconfigured');
  }
  return found;
}
