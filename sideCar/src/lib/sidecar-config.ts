import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('sidecar-config');

// Same directory as config.json but separate file
const SIDECAR_CONFIG_PATH = process.env.SIDECAR_CONFIG_PATH ||
  path.join(path.dirname(process.argv[1] || __filename), 'config', 'sidecar.config.json');

export type HostOsValue = 'darwin' | 'win32' | 'linux';

interface SidecarConfig {
  serverUrl: string | null;
  name?: string; // optional friendly name
  // Setup-wizard overrides — when present, override auto-detected / env values
  // at boot. Persisted by POST /api/host-os and POST /api/host-backend.
  hostOsOverride?: HostOsValue;
  hostOllamaEnabledOverride?: boolean;
  hostOllamaRolesOverride?: string[];
  hostOllamaBudgetMbOverride?: number;
  dmrEnabledOverride?: boolean;
  dmrRolesOverride?: string[];
}

export function loadSidecarConfig(): SidecarConfig | null {
  try {
    if (fs.existsSync(SIDECAR_CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(SIDECAR_CONFIG_PATH, 'utf8'));
      log.info(`Loaded sidecar config from ${SIDECAR_CONFIG_PATH} (serverUrl=${data.serverUrl})`);
      return data;
    }
  } catch (err) {
    log.error(`Failed to load sidecar config: ${(err as Error).message}`);
  }
  return null;
}

export function saveSidecarConfig(config: Partial<SidecarConfig>): void {
  try {
    const dir = path.dirname(SIDECAR_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Read existing file first — never lose existing fields
    let existing: SidecarConfig = { serverUrl: null };
    try {
      if (fs.existsSync(SIDECAR_CONFIG_PATH)) {
        existing = JSON.parse(fs.readFileSync(SIDECAR_CONFIG_PATH, 'utf8'));
      }
    } catch { /* start fresh */ }

    const merged = { ...existing, ...config };
    fs.writeFileSync(SIDECAR_CONFIG_PATH, JSON.stringify(merged, null, 2));
    log.info(`Sidecar config saved to ${SIDECAR_CONFIG_PATH} (serverUrl=${merged.serverUrl})`);
  } catch (err) {
    log.error(`Failed to save sidecar config: ${(err as Error).message}`);
  }
}

export function getSidecarConfigPath(): string { return SIDECAR_CONFIG_PATH; }
