import fs from 'fs';
import path from 'path';
import { state, ensureMaster, syncLegacyServerUrl } from './state';
import { createLogger } from './logger';
import { loadSidecarConfig, saveSidecarConfig } from './sidecar-config';

const log = createLogger('config');

const CONFIG_PATH = process.env.CONFIG_PATH ||
  path.join(path.dirname(process.argv[1] || __filename), 'config', 'config.json');

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
