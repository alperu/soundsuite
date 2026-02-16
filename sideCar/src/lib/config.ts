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
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (data.serverUrl) {
        state.serverUrl = data.serverUrl;
        log.info(`Loaded saved server URL: ${state.serverUrl}`);
      }
      if (data.idleTimeouts) {
        Object.assign(state.idleTimeouts, data.idleTimeouts);
        log.info('Loaded saved idle timeouts', state.idleTimeouts);
      }
      if (data.mode) {
        state.currentMode = data.mode;
        log.info(`Loaded saved mode: ${state.currentMode}`);
      }
      if (data.agentUrl) {
        state.savedAgentUrl = data.agentUrl;
        log.info(`Loaded saved agent URL: ${state.savedAgentUrl}`);
      }
      if (data.registry) {
        for (const [role, overrides] of Object.entries(data.registry)) {
          if (state.registry[role]) Object.assign(state.registry[role], overrides);
        }
        log.info('Loaded saved registry overrides');
      }
      // sidecar.config.json is the authoritative source for serverUrl
      const sidecarConfig = loadSidecarConfig();
      if (sidecarConfig?.serverUrl) {
        state.serverUrl = sidecarConfig.serverUrl;
        log.info(`sidecar.config serverUrl overrides config.json (${sidecarConfig.serverUrl})`);
      }
      // Migrate stale OCR model name (community model requires namespace prefix)
      if (state.registry.ocr?.model === 'olmocr2:7b-q8') {
        state.registry.ocr.model = 'richardyoung/olmocr2:7b-q8';
        log.info('Migrated OCR model name: olmocr2:7b-q8 → richardyoung/olmocr2:7b-q8');
      }
      return data;
    }
  } catch (err) {
    log.error(`Failed to load config: ${(err as Error).message}`);
  }
  log.info('No saved config found — fresh start');
  return null;
}

export function saveConfig(): void {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      serverUrl: state.serverUrl,
      agentUrl: state.savedAgentUrl,
      idleTimeouts: state.idleTimeouts,
      mode: state.currentMode,
      registry: Object.fromEntries(
        Object.entries(state.registry).map(([role, def]) => [role, { model: def.model, port: def.port }])
      ),
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
    log.info(`Config saved to ${CONFIG_PATH} (serverUrl=${data.serverUrl}, agentUrl=${data.agentUrl})`);
  } catch (err) {
    log.error(`Failed to save config to ${CONFIG_PATH}: ${(err as Error).message}`);
  }
}

/** Return the resolved config file path for diagnostics. */
export function getConfigPath(): string { return CONFIG_PATH; }
