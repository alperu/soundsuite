/**
 * Per-master ss-rlm-sandbox slot: the one piece of OpenRouter config a sidecar
 * still holds (docs/tasks/58, 59).
 *
 * Masters call OpenRouter themselves for embedding, rerank and chat. The
 * sandbox container is the exception: it runs on this host and needs, for each
 * request, the calling master's key, sandbox model and retrieval domain. The
 * master pushes them in its config push (`payload.openrouter`); the sandbox
 * reads them back over `GET /api/rlm-sandbox/master-config` and then calls
 * OpenRouter directly.
 *
 * ## Per-master scoping
 *
 * Keyed by the master's `serverUrl` (the same key `state.masters` uses). A
 * request for master M never falls through to another master's slot, so Sound
 * Suite and Fantom cannot spend each other's key.
 *
 * Deliberately NOT on `MasterConnection` (./state): `saveConfig()` writes that
 * struct to config.json, and the key must never reach that file.
 *
 * ## Persistence
 *
 * In memory (process-global — Next.js runs instrumentation and routes in
 * separate webpack layers, see ./process-global.ts) and in `openrouter.enc.json`
 * via ./openrouter-store (encrypted with the data key). The file keeps the
 * pre-task-59 shape (`modeByRole` included, always empty now) so an older
 * sidecar can still read it after a rollback.
 *
 * ## Key hygiene
 *
 * The key is never logged and never returned by `getSlotStatus()` (presence
 * only). The one place it leaves this module is `resolveSandboxSlot()`, which
 * only the token-checked hand-off route calls.
 */
import { createLogger } from './logger';
import { processGlobal } from './process-global';
import { loadOpenRouterStore, saveOpenRouterStore, type StoredMasterConfig } from './openrouter-store';
import { purposeKey } from './secret-box';

const log = createLogger('sandbox-slot');

export const SANDBOX_ROLE = 'rlm-sandbox';

export type SandboxDomain = 'legal' | 'code';
const VALID_DOMAINS: SandboxDomain[] = ['legal', 'code'];

export interface SandboxSlot {
  apiKey?: string;
  /** OpenRouter model id for ss-rlm-sandbox, or undefined if the master set none. */
  model?: string;
  domain?: SandboxDomain;
}

const G = processGlobal('sandbox-slot', () => ({
  byMaster: new Map<string, SandboxSlot>(),
}));

function sanitizeDomain(raw: unknown): SandboxDomain | undefined {
  return typeof raw === 'string' && (VALID_DOMAINS as string[]).includes(raw)
    ? (raw as SandboxDomain)
    : undefined;
}

/** `allowedModels['rlm-sandbox']` as either `{model}` or a bare string. Every
 *  other role an older master may still send is ignored. */
function sandboxModelFrom(allowedModels: unknown): string | undefined {
  if (!allowedModels || typeof allowedModels !== 'object') return undefined;
  const v = (allowedModels as Record<string, unknown>)[SANDBOX_ROLE];
  const m = typeof v === 'string' ? v : (v && typeof v === 'object' ? (v as Record<string, unknown>).model : undefined);
  return typeof m === 'string' && m.trim() ? m.trim() : undefined;
}

function persist(): void {
  const out = new Map<string, StoredMasterConfig>();
  for (const [url, s] of G.byMaster) {
    // The store only keeps entries with a key (it did before task 59 too).
    if (!s.apiKey) continue;
    out.set(url, {
      apiKey: s.apiKey,
      allowedModels: s.model ? { [SANDBOX_ROLE]: { model: s.model } } : {},
      modeByRole: {},
      ...(s.domain ? { domain: s.domain } : {}),
    });
  }
  saveOpenRouterStore(out);
}

/**
 * Apply `payload.openrouter` from a config push.
 *
 * - object → store this master's slot. An `apiKey` missing from the object
 *   keeps the stored one; `allowedModels` / `domain` missing keep theirs. Any
 *   other role in `allowedModels` and any `modeByRole` (old masters) is ignored.
 * - `null` → clear this master's slot (task 58).
 * - anything else (absent) → no change.
 */
export function applyOpenRouterPush(serverUrl: string, payload: unknown): void {
  if (payload === null) {
    if (G.byMaster.delete(serverUrl)) {
      persist();
      log.info(`[${serverUrl}] OpenRouter sandbox slot cleared by master`);
    }
    return;
  }
  if (!payload || typeof payload !== 'object') return;
  const obj = payload as Record<string, unknown>;
  const existing = G.byMaster.get(serverUrl);

  const apiKey = typeof obj.apiKey === 'string' && obj.apiKey ? obj.apiKey : existing?.apiKey;
  const model = obj.allowedModels !== undefined ? sandboxModelFrom(obj.allowedModels) : existing?.model;
  const domain = obj.domain !== undefined ? (sanitizeDomain(obj.domain) ?? existing?.domain) : existing?.domain;

  G.byMaster.set(serverUrl, { apiKey, model, domain });
  persist();
  log.info(
    `[${serverUrl}] sandbox slot updated — key ${apiKey ? 'present' : 'missing'}, ` +
      `model ${model ?? '(none)'}, domain ${domain ?? '(none)'}`,
  );
}

/** Drop a master's slot when the master itself is retired — a URL later reused
 *  by a different master must not inherit this one's key. */
export function clearSandboxSlot(serverUrl: string): void {
  if (G.byMaster.delete(serverUrl)) {
    persist();
    log.info(`[${serverUrl}] sandbox slot cleared (master retired)`);
  }
}

/** Boot: restore slots from openrouter.enc.json. Old files may hold full
 *  pre-task-59 blocks; only the sandbox fields are kept. */
export function restoreSandboxSlots(): number {
  let restored = 0;
  for (const [url, cfg] of loadOpenRouterStore()) {
    if (G.byMaster.has(url)) continue;
    G.byMaster.set(url, {
      apiKey: cfg.apiKey,
      model: sandboxModelFrom(cfg.allowedModels),
      domain: sanitizeDomain(cfg.domain),
    });
    restored++;
  }
  return restored;
}

/**
 * Presence-only status for `/api/status` (`masters[].virtualInference`).
 * Fantom reads `openrouter` to find its slot and re-pushes when it is 'unset'.
 * 'configured' = key AND sandbox model present.
 */
export function getSlotStatus(serverUrl: string): { openrouter: 'configured' | 'unset'; domain?: SandboxDomain } {
  const s = G.byMaster.get(serverUrl);
  return {
    openrouter: s?.apiKey && s.model ? 'configured' : 'unset',
    ...(s?.domain ? { domain: s.domain } : {}),
  };
}

export type SandboxSlotResolution =
  | { ok: true; serverUrl: string; apiKey: string; model: string; domain: SandboxDomain | null }
  | { ok: false; status: number; error: string };

/**
 * Which master's slot a sandbox request should use.
 *
 * With `explicitServerUrl` (the X-SoundSuite-Master / X-FantomMCP-Master the
 * sandbox received): that master's slot or an error — 404 no slot, 503 no key
 * or no model. Without it: the one usable slot, 409 when several masters have
 * one (refuse to guess whose budget to spend), 503 when none.
 */
export function resolveSandboxSlot(explicitServerUrl?: string): SandboxSlotResolution {
  const check = (url: string, s: SandboxSlot): SandboxSlotResolution => {
    if (!s.apiKey) return { ok: false, status: 503, error: `master ${url} has no OpenRouter key on this sidecar` };
    if (!s.model) {
      return { ok: false, status: 503, error: `master ${url} has not configured a model for ${SANDBOX_ROLE}` };
    }
    return { ok: true, serverUrl: url, apiKey: s.apiKey, model: s.model, domain: s.domain ?? null };
  };

  if (explicitServerUrl) {
    const s = G.byMaster.get(explicitServerUrl);
    if (!s) return { ok: false, status: 404, error: `master ${explicitServerUrl} has pushed no OpenRouter sandbox slot` };
    return check(explicitServerUrl, s);
  }

  const usable = [...G.byMaster.entries()].filter(([, s]) => !!s.apiKey);
  if (usable.length === 0) {
    return { ok: false, status: 503, error: 'no master has pushed an OpenRouter key to this sidecar' };
  }
  if (usable.length > 1) {
    return {
      ok: false,
      status: 409,
      error:
        `${usable.length} masters have OpenRouter keys on this sidecar ` +
        `(${usable.map(([u]) => u).join(', ')}). The caller must identify itself ` +
        `with the X-SoundSuite-Master header — refusing to guess whose key and budget to spend.`,
    };
  }
  return check(usable[0][0], usable[0][1]);
}

/**
 * Shared secret between this sidecar and its sandbox container. Passed to the
 * container as `SS_SANDBOX_TOKEN` and checked by the hand-off route. Derived
 * from the data key so it is the same across sidecar restarts and container
 * re-creates (no drift, no recreate loop).
 */
export function sandboxToken(): string {
  return purposeKey('rlm-sandbox-token').toString('hex');
}

export function __resetSandboxSlotsForTest(): void {
  G.byMaster.clear();
}
