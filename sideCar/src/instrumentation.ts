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

    // Multi-master: state.masters is now the source of truth. Env-bootstrap
    // already happened inside loadSavedConfig() (SIDECAR_MASTERS, SOUND_SUITE_MASTER_URL,
    // SERVER_URL all merged). Just kick off the gossip client.
    if (state.masters.size > 0) {
      log.info(`Resuming with ${state.masters.size} master(s): ${[...state.masters.keys()].join(', ')}`);
    }
    if (state.savedAgentUrl) {
      log.info(`Resuming with saved agentUrl: ${state.savedAgentUrl}`);
    }

    if (state.masters.size > 0) {
      log.info(`Starting gossip client → ${state.masters.size} master(s)`);
      startGossipClient().catch(err => {
        log.error(`Gossip client startup failed: ${(err as Error).message}`);
      });
    }
  }
}
