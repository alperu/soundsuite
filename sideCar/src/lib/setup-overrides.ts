/**
 * Setup-wizard overrides applied at boot and on every POST from the UI.
 *
 * The setup wizard at /setup writes operator selections to
 * sidecar.config.json (hostOsOverride, hostOllama*Override, dmr*Override).
 * This module reads those, mutates `state`, and re-runs
 * `applyHostOllamaOverrides()` so the registry picks up runtime changes
 * without a restart.
 *
 * Default behaviour when nothing is configured = current env-var behaviour.
 */

import { state, applyHostOllamaOverrides } from './state';
import { loadSidecarConfig, saveSidecarConfig, type HostOsValue } from './sidecar-config';
import { createLogger } from './logger';

const log = createLogger('setup-overrides');

/** Apply persisted overrides from sidecar.config.json to in-memory state.
 *  Call once at boot after detectHostOs() + loadSavedConfig(). Idempotent. */
export function applySetupOverrides(): void {
  const cfg = loadSidecarConfig();
  if (!cfg) return;

  if (cfg.hostOsOverride && (cfg.hostOsOverride === 'darwin' || cfg.hostOsOverride === 'win32' || cfg.hostOsOverride === 'linux')) {
    // Master-pushed override (from config.json) takes precedence — don't
    // clobber it with a stale /setup-wizard choice. The operator's latest
    // intent on /admin/host-provisioning wins over an earlier local choice.
    if (state.hostOsConfidence === 'master-override') {
      log.info(`Skipping local hostOs override (${cfg.hostOsOverride}) — master-pushed override (${state.hostOs}) takes precedence`);
    } else {
      state.hostOs = cfg.hostOsOverride;
      state.hostOsConfidence = 'override';
      log.info(`Applied hostOs override: ${cfg.hostOsOverride}`);
    }
  }

  if (typeof cfg.hostOllamaEnabledOverride === 'boolean') {
    state.hostOllamaEnabled = cfg.hostOllamaEnabledOverride;
  }
  if (Array.isArray(cfg.hostOllamaRolesOverride)) {
    state.hostOllamaRoles = new Set(cfg.hostOllamaRolesOverride);
    // If roles are configured but enabled flag wasn't set, infer enable.
    if (cfg.hostOllamaEnabledOverride === undefined && cfg.hostOllamaRolesOverride.length > 0) {
      state.hostOllamaEnabled = true;
    }
  }
  if (typeof cfg.hostOllamaBudgetMbOverride === 'number' && cfg.hostOllamaBudgetMbOverride >= 0) {
    state.hostOllamaBudgetMb = cfg.hostOllamaBudgetMbOverride;
  }

  if (typeof cfg.dmrEnabledOverride === 'boolean') {
    state.dmrEnabled = cfg.dmrEnabledOverride;
  }
  if (Array.isArray(cfg.dmrRolesOverride)) {
    state.dmrRoles = new Set(cfg.dmrRolesOverride);
    if (cfg.dmrEnabledOverride === undefined && cfg.dmrRolesOverride.length > 0) {
      state.dmrEnabled = true;
    }
  }

  applyHostOllamaOverrides();
}

export interface HostBackendPatch {
  hostOllamaEnabled?: boolean;
  hostOllamaRoles?: string[];
  hostOllamaBudgetMb?: number;
  dmrEnabled?: boolean;
  dmrRoles?: string[];
}

/** Persist a host-backend selection from the UI and apply live. */
export function persistAndApplyBackend(patch: HostBackendPatch): void {
  const save: Parameters<typeof saveSidecarConfig>[0] = {};
  if (typeof patch.hostOllamaEnabled === 'boolean') {
    save.hostOllamaEnabledOverride = patch.hostOllamaEnabled;
    state.hostOllamaEnabled = patch.hostOllamaEnabled;
  }
  if (Array.isArray(patch.hostOllamaRoles)) {
    save.hostOllamaRolesOverride = patch.hostOllamaRoles;
    state.hostOllamaRoles = new Set(patch.hostOllamaRoles);
    if (patch.hostOllamaEnabled === undefined && patch.hostOllamaRoles.length > 0) {
      save.hostOllamaEnabledOverride = true;
      state.hostOllamaEnabled = true;
    }
  }
  if (typeof patch.hostOllamaBudgetMb === 'number') {
    save.hostOllamaBudgetMbOverride = patch.hostOllamaBudgetMb;
    state.hostOllamaBudgetMb = patch.hostOllamaBudgetMb;
  }
  if (typeof patch.dmrEnabled === 'boolean') {
    save.dmrEnabledOverride = patch.dmrEnabled;
    state.dmrEnabled = patch.dmrEnabled;
  }
  if (Array.isArray(patch.dmrRoles)) {
    save.dmrRolesOverride = patch.dmrRoles;
    state.dmrRoles = new Set(patch.dmrRoles);
    if (patch.dmrEnabled === undefined && patch.dmrRoles.length > 0) {
      save.dmrEnabledOverride = true;
      state.dmrEnabled = true;
    }
  }
  saveSidecarConfig(save);
  applyHostOllamaOverrides();
  log.info(
    `Backend applied: hostOllama=${state.hostOllamaEnabled} ` +
    `[${[...state.hostOllamaRoles].join(',')}] budgetMb=${state.hostOllamaBudgetMb} | ` +
    `dmr=${state.dmrEnabled} [${[...state.dmrRoles].join(',')}]`,
  );
}

/** Persist a host-OS override and apply live. */
export function persistAndApplyHostOs(os: HostOsValue): void {
  state.hostOs = os;
  state.hostOsConfidence = 'override';
  saveSidecarConfig({ hostOsOverride: os });
  applyHostOllamaOverrides();
  log.info(`Host OS override applied: ${os}`);
}
