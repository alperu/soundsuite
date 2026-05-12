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

    // Detect Docker host OS (darwin/win32/linux) — used by admin UI to render
    // OS-correct install instructions for native Ollama. Cheap, one /info call.
    try {
      const { detectHostOs } = await import('./lib/host-os');
      await detectHostOs();
    } catch (err) {
      log.warn(`host-os detection failed: ${(err as Error).message}`);
    }

    loadSavedConfig();

    // Apply setup-wizard overrides from sidecar.config.json BEFORE the
    // overrides reapply below. These set hostOs / hostOllama / dmr fields
    // from operator's UI selections (taking precedence over env / autodetect).
    try {
      const { applySetupOverrides } = await import('./lib/setup-overrides');
      applySetupOverrides();
    } catch (err) {
      log.warn(`setup overrides failed: ${(err as Error).message}`);
    }

    // Re-apply host-Ollama overrides after config load — loadSavedConfig may
    // have replaced the registry with a master-pushed version that doesn't
    // carry the `runtime: 'host'` field.
    try {
      const { applyHostOllamaOverrides } = await import('./lib/state');
      applyHostOllamaOverrides();
      if (state.hostOllamaEnabled) {
        log.info(`host-ollama enabled: host=${state.hostOllamaHost} roles=[${[...state.hostOllamaRoles].join(',')}] budgetMb=${state.hostOllamaBudgetMb}`);
      }
      if (state.dmrEnabled) {
        log.info(`DMR enabled: host=${state.dmrHost} port=${state.dmrPort} roles=[${[...state.dmrRoles].join(',')}] budgetMb=${state.dmrBudgetMb}`);
      }
      if (state.hostOllamaEnabled || state.dmrEnabled) {
        const { startHostOllamaWatchdog } = await import('./lib/host-ollama-watchdog');
        startHostOllamaWatchdog();
      }
    } catch (err) {
      log.warn(`host-runtime setup failed: ${(err as Error).message}`);
    }

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
