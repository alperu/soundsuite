export async function register() {
  // Only run on server (not edge)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadSavedConfig } = await import('./lib/config');
    const { startGossipClient } = await import('./lib/ws-client');
    const { state } = await import('./lib/state');
    const { createLogger } = await import('./lib/logger');

    const { initDocker } = await import('./lib/docker');
    const log = createLogger('startup');

    log.info(`GPU Orchestrator Agent starting...`);

    // Detect Docker connection (socket vs TCP) before anything else
    await initDocker();
    log.info(`Managed roles: ${Object.keys(state.registry).join(', ')}`);
    log.info(`Default mode: ${state.currentMode}`);
    log.info(`Idle timeouts: ${JSON.stringify(state.idleTimeouts)}`);

    loadSavedConfig();

    // Read version from VERSION file
    const path = await import('path');
    const fs = await import('fs');
    const versionPath = path.join(process.cwd(), 'VERSION');
    let version = 'unknown';
    try { version = fs.readFileSync(versionPath, 'utf8').trim(); } catch {}

    log.info(`Sidecar v${version} started`);

    if (state.serverUrl) {
      log.info(`Resuming saved connection → ${state.serverUrl}`);
    }
    if (state.savedAgentUrl) {
      log.info(`Resuming with saved agentUrl: ${state.savedAgentUrl}`);
    }

    // CLI / env override: SOUND_SUITE_MASTER_URL (canonical) or SERVER_URL
    // (back-compat) always wins. Critical for greenfield boots and surviving
    // updates that wipe the local config dir — sidecar can reconstruct the
    // master URL from a single env var the operator sets in `docker run`.
    const envUrl = process.env.SOUND_SUITE_MASTER_URL || process.env.SERVER_URL;
    if (envUrl) {
      const which = process.env.SOUND_SUITE_MASTER_URL ? 'SOUND_SUITE_MASTER_URL' : 'SERVER_URL';
      if (state.serverUrl && state.serverUrl !== envUrl) {
        log.info(`Server URL override: ${state.serverUrl} → ${envUrl} (from ${which})`);
      }
      state.serverUrl = envUrl;
      log.info(`Server URL from environment (${which}): ${state.serverUrl}`);
    }

    if (state.serverUrl) {
      log.info(`Starting gossip client → ${state.serverUrl}`);
      // Auto-provision + connect (async, don't block startup)
      startGossipClient().catch(err => {
        log.error(`Gossip client startup failed: ${(err as Error).message}`);
      });
    }
  }
}
