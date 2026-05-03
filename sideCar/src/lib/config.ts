import fs from 'fs';
import path from 'path';
import { state } from './state';
import { createLogger } from './logger';
import { loadSidecarConfig } from './sidecar-config';

const log = createLogger('config');

// Resolve relative to install dir (where server.js lives), not hardcoded /app/
// Docker: WORKDIR /app → /app/config/config.json (matches volume mount)
// Bare-metal: ~/sidecar/ → ~/sidecar/config/config.json (writable, persists across updates)
const CONFIG_PATH = process.env.CONFIG_PATH ||
  path.join(path.dirname(process.argv[1] || __filename), 'config', 'config.json');

export function loadSavedConfig(): Record<string, unknown> | null {
  log.info(`Config path: ${CONFIG_PATH} (exists: ${fs.existsSync(CONFIG_PATH)})`);
  let data: Record<string, unknown> | null = null;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
      if (data.serverUrl) {
        state.serverUrl = data.serverUrl as string;
        log.info(`Loaded saved server URL: ${state.serverUrl}`);
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

  // sidecar.config.json is the authoritative source for serverUrl. ALWAYS check it,
  // even when config.json is missing or corrupted — otherwise a partially-wiped
  // install dir loses the IP and the operator has to re-enter it on every update.
  try {
    const sidecarConfig = loadSidecarConfig();
    if (sidecarConfig?.serverUrl) {
      state.serverUrl = sidecarConfig.serverUrl;
      log.info(`Loaded serverUrl from sidecar.config.json: ${state.serverUrl}`);
    }
  } catch (err) {
    log.error(`Failed to load sidecar.config.json: ${(err as Error).message}`);
  }

  // Also load the SERVER_URL env var as a last-resort source. The self-update
  // flow sets this when spawning the post-update child process.
  if (!state.serverUrl && process.env.SERVER_URL) {
    state.serverUrl = process.env.SERVER_URL;
    log.info(`Loaded serverUrl from SERVER_URL env: ${state.serverUrl}`);
  }

  if (!state.serverUrl) {
    log.info('No saved serverUrl found in config.json, sidecar.config.json, or SERVER_URL env — fresh start');
  }
  return data;
}

export function saveConfig(): void {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      serverUrl: state.serverUrl,
      agentUrl: state.savedAgentUrl,
      idleTimeouts: state.idleTimeouts,
      minOnline: state.minOnline,
      mode: state.currentMode,
      registry: Object.fromEntries(
        Object.entries(state.registry).map(([role, def]) => [role, { model: def.model, port: def.port }])
      ),
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
    log.info(`Config saved to ${CONFIG_PATH} (serverUrl=${data.serverUrl}, agentUrl=${data.agentUrl})`);

    // Mirror serverUrl into sidecar.config.json so EITHER file alone is enough
    // to restore the IP after an update. Two-file redundancy: lose one, the
    // other still has the URL. Avoids "had to re-enter IP after update".
    if (state.serverUrl) {
      try {
        // Lazy import to avoid circular dep at module load
        const { saveSidecarConfig } = require('./sidecar-config') as typeof import('./sidecar-config');
        saveSidecarConfig({ serverUrl: state.serverUrl });
      } catch (err) {
        log.warn(`Could not mirror to sidecar.config.json: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log.error(`Failed to save config to ${CONFIG_PATH}: ${(err as Error).message}`);
  }
}

/** Return the resolved config file path for diagnostics. */
export function getConfigPath(): string { return CONFIG_PATH; }
