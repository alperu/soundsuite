import fs from 'fs';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import http from 'http';
import https from 'https';
import { execSync, spawn } from 'child_process';
import { createLogger } from './logger';
import { state } from './state';
import { saveConfig, getConfigPath } from './config';
import { disconnectWebSocket, getAgentUrl } from './ws-client';

const log = createLogger('self-update');

function getInstallDir(): string {
  // The directory where server.js lives (standalone root)
  return path.dirname(process.argv[1] || __filename);
}

function getCurrentVersion(): string {
  const versionFile = path.join(getInstallDir(), 'VERSION');
  try {
    return fs.readFileSync(versionFile, 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

function httpGet(url: string): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (location) return httpGet(location).then(resolve, reject);
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode!,
        headers: res.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

export async function checkForUpdate(serverUrl: string): Promise<{ available: boolean; version?: string }> {
  const currentVersion = getCurrentVersion();
  try {
    const versionUrl = `${serverUrl}/api/admin/gpu/sidecars/version`;
    const { statusCode, body } = await httpGet(versionUrl);
    if (statusCode !== 200) return { available: false };

    const manifest = JSON.parse(body.toString());
    if (manifest.version && manifest.version !== currentVersion) {
      log.info(`Update available: ${currentVersion} -> ${manifest.version}`);
      return { available: true, version: manifest.version };
    }
    return { available: false };
  } catch (err) {
    log.error(`Update check failed: ${(err as Error).message}`);
    return { available: false };
  }
}

export async function performUpdate(serverUrl: string): Promise<boolean> {
  const installDir = getInstallDir();
  const currentVersion = getCurrentVersion();

  try {
    // 1. Download the tarball
    const downloadUrl = `${serverUrl}/api/admin/gpu/sidecars/download`;
    log.info(`Downloading update from ${downloadUrl}...`);
    const { statusCode, headers, body } = await httpGet(downloadUrl);

    if (statusCode !== 200) {
      log.error(`Download failed with status ${statusCode}`);
      return false;
    }

    const newVersion = headers['x-sidecar-version'] || 'unknown';
    const expectedHash = headers['x-sidecar-sha256'];

    // 2. Save tarball to temp file
    const tmpTarball = path.join(installDir, `_update-${newVersion}.tar.gz`);
    fs.writeFileSync(tmpTarball, body);

    // 3. Verify checksum if available
    if (expectedHash) {
      const crypto = await import('crypto');
      const actualHash = crypto.createHash('sha256').update(body).digest('hex');
      if (actualHash !== expectedHash) {
        log.error(`Checksum mismatch! Expected ${expectedHash}, got ${actualHash}`);
        fs.unlinkSync(tmpTarball);
        return false;
      }
      log.info('Checksum verified');
    }

    // 4. Backup current installation
    const backupDir = path.join(installDir, `_backup-${currentVersion}`);
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true });
    }

    // Back up key files (not node_modules to save space)
    fs.mkdirSync(backupDir, { recursive: true });
    for (const item of ['server.js', 'VERSION', 'package.json']) {
      const src = path.join(installDir, item);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, item));
      }
    }

    // 5. Extract update (tar strips the leading "sidecar/" directory)
    const extractDir = path.join(installDir, '_update-extract');
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true });
    }
    fs.mkdirSync(extractDir, { recursive: true });

    // Cross-platform tar extraction
    try {
      execSync(`tar xzf "${tmpTarball}" -C "${extractDir}"`, { stdio: 'pipe' });
    } catch {
      // Windows fallback: try PowerShell
      try {
        execSync(
          `powershell -Command "tar xzf '${tmpTarball}' -C '${extractDir}'"`,
          { stdio: 'pipe' },
        );
      } catch (e2) {
        log.error(`Failed to extract update: ${(e2 as Error).message}`);
        fs.unlinkSync(tmpTarball);
        fs.rmSync(extractDir, { recursive: true });
        return false;
      }
    }

    // 6. Copy extracted files over current installation
    const extractedSidecar = path.join(extractDir, 'sidecar');
    if (!fs.existsSync(extractedSidecar)) {
      log.error('Extracted archive missing sidecar/ directory');
      fs.unlinkSync(tmpTarball);
      fs.rmSync(extractDir, { recursive: true });
      return false;
    }

    // Back up ENTIRE config/ directory before overwriting
    // (includes config.json AND sidecar.config.json — the authoritative serverUrl source)
    const configDir = path.join(installDir, 'config');
    const configBackupDir = path.join(installDir, '_config-backup');
    if (fs.existsSync(configDir)) {
      if (fs.existsSync(configBackupDir)) fs.rmSync(configBackupDir, { recursive: true });
      fs.cpSync(configDir, configBackupDir, { recursive: true });
      log.info('Backed up entire config/ directory before update');
    }

    copyDirSync(extractedSidecar, installDir);

    // Restore entire config/ directory after extraction
    if (fs.existsSync(configBackupDir)) {
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.cpSync(configBackupDir, configDir, { recursive: true });
      fs.rmSync(configBackupDir, { recursive: true });
      log.info('Restored config/ directory after update (config.json + sidecar.config.json)');
    }

    // 7. Cleanup
    fs.unlinkSync(tmpTarball);
    fs.rmSync(extractDir, { recursive: true });

    // Remove old backups (keep only the latest)
    for (const entry of fs.readdirSync(installDir)) {
      if (entry.startsWith('_backup-') && entry !== `_backup-${currentVersion}`) {
        fs.rmSync(path.join(installDir, entry), { recursive: true, force: true });
      }
    }

    log.info(`Update to v${newVersion} extracted successfully. Restarting...`);

    // 8. Save current agentUrl and serverUrl so the new process uses the same URLs
    state.savedAgentUrl = getAgentUrl();
    saveConfig();
    const resolvedConfigPath = getConfigPath();

    // Also force-write sidecar.config.json to ensure serverUrl survives
    const { saveSidecarConfig, getSidecarConfigPath } = await import('./sidecar-config');
    if (state.serverUrl) {
      saveSidecarConfig({ serverUrl: state.serverUrl });
      log.info(`Force-saved sidecar.config.json with serverUrl=${state.serverUrl}`);
    }
    const resolvedSidecarConfigPath = getSidecarConfigPath();

    log.info(`Pre-restart state: serverUrl=${state.serverUrl}, agentUrl=${state.savedAgentUrl}`);
    log.info(`Config paths: config=${resolvedConfigPath}, sidecar=${resolvedSidecarConfigPath}`);

    // Verify both config files were actually written
    for (const p of [resolvedConfigPath, resolvedSidecarConfigPath]) {
      if (fs.existsSync(p)) {
        const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
        log.info(`Config verified [${path.basename(p)}]: serverUrl=${saved.serverUrl}`);
      } else {
        log.error(`Config NOT found at ${p} after save!`);
      }
    }

    // 9. Graceful shutdown: disconnect WS + heartbeats to free the port
    disconnectWebSocket();

    // 10. Restart: spawn with shell sleep so parent exits first and frees port
    // Pass ALL config paths + SERVER_URL as env vars — belt and suspenders
    const serverJs = path.join(installDir, 'server.js');
    const childEnv = {
      ...process.env,
      CONFIG_PATH: resolvedConfigPath,
      SIDECAR_CONFIG_PATH: resolvedSidecarConfigPath,
      SERVER_URL: state.serverUrl || process.env.SERVER_URL || '',
    };
    const child = spawn('sh', ['-c', `sleep 3 && exec node "${serverJs}"`], {
      detached: true,
      stdio: 'ignore',
      env: childEnv,
      cwd: installDir,
    });
    child.unref();

    // Exit immediately — frees port 8098 before the child starts
    process.exit(0);

    return true;
  } catch (err) {
    log.error(`Update failed: ${(err as Error).message}`);
    return false;
  }
}

function copyDirSync(src: string, dest: string) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip backup/temp dirs AND config directory (never overwrite user config from tarball)
    if (entry.name.startsWith('_backup-') || entry.name.startsWith('_update-') || entry.name.startsWith('_config-') || entry.name === 'config') continue;

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
