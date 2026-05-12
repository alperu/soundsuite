export async function register() {
  // Only run on server (not edge)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadSavedConfig } = await import('./lib/config');
    const { startGossipClient } = await import('./lib/ws-client');
    const { state } = await import('./lib/state');
    const { createLogger } = await import('./lib/logger');
    const { emitBootEvent } = await import('./lib/boot-events');

    const { initDocker } = await import('./lib/docker');
    const log = createLogger('startup');

    // Read version up-front so it can label the first boot event.
    const path = await import('path');
    const fs = await import('fs');
    let bootVersion = 'unknown';
    try {
      const versionPath = path.join(process.cwd(), 'VERSION');
      bootVersion = fs.readFileSync(versionPath, 'utf8').trim();
    } catch {
      try {
        const pkgPath = path.join(process.cwd(), 'package.json');
        bootVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || 'unknown';
      } catch { /* keep unknown */ }
    }

    emitBootEvent(`Sidecar boot started — version ${bootVersion}`, { version: bootVersion });

    // Resolve internal IP (container's primary non-loopback IPv4) for visibility.
    try {
      const os = await import('os');
      let internalIp = 'unknown';
      for (const iface of Object.values(os.networkInterfaces())) {
        if (!iface) continue;
        for (const info of iface) {
          if (info.family === 'IPv4' && !info.internal) { internalIp = info.address; break; }
        }
        if (internalIp !== 'unknown') break;
      }
      const external = process.env.SS_EXTERNAL_IP || null;
      emitBootEvent(
        `IP acquired: ${internalIp} (container)${external ? ` / ${external} (external)` : ''}`,
        { internalIp, externalIp: external },
      );
    } catch (err) {
      emitBootEvent(`IP acquisition failed: ${(err as Error).message}`);
    }

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
      emitBootEvent(
        `OS detected: ${state.hostOs} (confidence: ${state.hostOsConfidence}; ` +
        `dockerDesktop=${state.hostOsDockerDesktop}; hasNvidiaSmi=${state.hasNvidiaSmi})`,
        {
          os: state.hostOs,
          confidence: state.hostOsConfidence,
          dockerDesktop: state.hostOsDockerDesktop,
          hasNvidiaSmi: state.hasNvidiaSmi,
        },
      );
    } catch (err) {
      log.warn(`host-os detection failed: ${(err as Error).message}`);
      emitBootEvent(`OS detection failed: ${(err as Error).message}`);
    }

    loadSavedConfig();
    emitBootEvent(
      `Registry resolved: roles=[${Object.keys(state.registry).join(', ')}]`,
      {
        roles: Object.entries(state.registry).map(([role, def]) => ({
          role,
          runtime: def?.runtime ?? 'docker',
          image: def?.image ?? '',
          model: def?.model ?? '',
        })),
      },
    );

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
      // Emit the resolved registry AFTER overrides — this is the version
      // the runtime actually uses. Makes regressions visible on the Activity
      // Log: operator sees "embedding: host / host-ollama / qwen3-embedding:0.6b".
      emitBootEvent('Registry resolved (final)', {
        roles: Object.entries(state.registry).map(([role, def]) => ({
          role,
          runtime: def?.runtime ?? 'docker',
          image: def?.image ?? '',
          model: def?.model ?? '',
        })),
      });

      // Always attempt to start the watchdog — it decides internally whether
      // to run based on env flags AND registry contents (any role with
      // runtime='host'). This catches the mac-docker-ollama path where the
      // master pushes runtime='host' via mode-templates but SS_HOST_OLLAMA
      // env wasn't set in the container.
      {
        const { startHostOllamaWatchdog } = await import('./lib/host-ollama-watchdog');
        startHostOllamaWatchdog();
      }
    } catch (err) {
      log.warn(`host-runtime setup failed: ${(err as Error).message}`);
    }

    log.info(`Sidecar v${bootVersion} started`);

    // Multi-master: state.masters is now the source of truth. Env-bootstrap
    // already happened inside loadSavedConfig() (SIDECAR_MASTERS, SOUND_SUITE_MASTER_URL,
    // SERVER_URL all merged). Just kick off the gossip client.
    if (state.masters.size > 0) {
      log.info(`Resuming with ${state.masters.size} master(s): ${[...state.masters.keys()].join(', ')}`);
    }
    if (state.savedAgentUrl) {
      log.info(`Resuming with saved agentUrl: ${state.savedAgentUrl}`);
    }

    // Always start the gossip client. Its watchdog (30s loop) will pick up
    // any masters added later — either by discovery (below) or operator UI.
    // When state.masters is empty, connectAllMasters() is a no-op and the
    // watchdog idles cheaply.
    if (state.masters.size > 0) {
      log.info(`Starting gossip client → ${state.masters.size} master(s)`);
    } else {
      log.info('Starting gossip client → no masters yet (discovery will run in background)');
    }
    startGossipClient().catch(err => {
      log.error(`Gossip client startup failed: ${(err as Error).message}`);
    });

    // Boot-time discovery: if no masters were loaded from persisted config or
    // env, sweep likely locations (recent-masters.json hint file, host.docker.internal,
    // default gateway, SIDECAR_MASTER_HOSTS). Fire-and-forget — never blocks boot.
    if (state.masters.size === 0) {
      (async () => {
        try {
          const { discoverMasters } = await import('./lib/config');
          const { connectMaster } = await import('./lib/ws-client');
          const found = await discoverMasters();
          if (found.length === 0) return;
          // Kick the watchdog by directly connecting newly-found masters; the
          // watchdog would catch them within 30s anyway, but this is snappier.
          for (const url of found) {
            const m = state.masters.get(url);
            if (m && m.connectionMode === 'disconnected') {
              try { connectMaster(m); } catch (err) {
                log.warn(`connectMaster failed for discovered ${url}: ${(err as Error).message}`);
              }
            }
          }
        } catch (err) {
          log.warn(`boot-time master discovery failed: ${(err as Error).message}`);
        }
      })();
    }
  }
}
