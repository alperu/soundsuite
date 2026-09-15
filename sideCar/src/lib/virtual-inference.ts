/**
 * Virtual inference — route a role to OpenRouter when its local model is
 * unavailable.
 *
 * ## Per-master scoping
 *
 * A single sidecar can serve multiple masters (Sound Suite, Fantom MCP, …),
 * each with its own OpenRouter key, allow-list and routing mode per role.
 * That configuration is keyed by `serverUrl` — the same key `state.masters`
 * uses — and resolving a request from master M NEVER falls through to
 * another master's settings. A master with no config pushed is local-only,
 * full stop.
 *
 * Deliberately NOT stored on `MasterConnection` in `./state`: that struct is
 * exactly what `saveConfig()` (./config.ts) walks to persist
 * `masters[].{serverUrl,authToken,wsPort}` to disk. Keeping OpenRouter
 * settings in this module's own process-global map means there is no field
 * for a future edit to `saveConfig()` to accidentally start serializing —
 * the key never touches that code path at all.
 *
 * ## Process-global
 *
 * Next.js compiles instrumentation and route handlers as separate webpack
 * layers, so a plain module-level `const configs = new Map()` would be two
 * independent maps in the same process — a config pushed over the WS
 * connection (instrumentation layer) would be invisible to a request handled
 * by a route (routes layer). See `./process-global.ts` for the full story
 * (this bit the fleet dashboard once already). Use `processGlobal` for any
 * state here.
 *
 * ## Key hygiene
 *
 * The OpenRouter API key lives ONLY in this in-memory map. It is never
 * written to disk (see above), never returned by `getStatus()` (presence
 * only: "configured" / "unset"), and never appears in a log line — every log
 * call here names the provider and model, never the key.
 */
import { createLogger } from './logger';
import { processGlobal } from './process-global';
import { embed as orEmbed, rerank as orRerank, keyInfo as orKeyInfo } from './openrouter-client';
import { loadOpenRouterStore, saveOpenRouterStore } from './openrouter-store';

const log = createLogger('virtual-inference');

export type RoutingMode = 'local-only' | 'local-first' | 'cloud-only';

const VALID_MODES: RoutingMode[] = ['local-only', 'local-first', 'cloud-only'];

/**
 * Known-good provider pins and embedding widths, verified 2026-09-15 (see
 * the master's curated catalogue at src/lib/openrouter/models.ts, which this
 * mirrors — the sidecar can't import it, see the module header). A master
 * can override either per role via `allowedModels[role].provider` /
 * `.dims`; these are only the fallback when it doesn't.
 */
const KNOWN_PROVIDER_PINS: Record<string, string> = {
  'qwen/qwen3-embedding-4b': 'DeepInfra',
  'qwen/qwen3-embedding-8b': 'DeepInfra',
  'qwen/qwen3-reranker-8b': 'Fireworks',
};
const KNOWN_DIMS: Record<string, number> = {
  'qwen/qwen3-embedding-4b': 2560,
  'qwen/qwen3-embedding-8b': 4096,
};

/** Model mapped to a role for cloud fallback. `provider` and `dims` override
 *  the KNOWN_* tables above for a model this sidecar doesn't recognize;
 *  `note` is an optional short annotation appended to log lines (e.g. a
 *  dimension count) — never sensitive. */
export interface OpenRouterModelConfig {
  model: string;
  /** Provider to pin embedding calls to. Falls back to KNOWN_PROVIDER_PINS[model]. */
  provider?: string;
  /** Expected embedding width, enforced on the response. Falls back to KNOWN_DIMS[model]. */
  dims?: number;
  note?: string;
}

export interface OpenRouterMasterConfig {
  /** Encrypted at rest (openrouter-store.ts). Never logged, never returned by
   *  getStatus(). Absent when the master pushed models/modes but no key —
   *  see setOpenRouterConfig. */
  apiKey?: string;
  allowedModels: Record<string, OpenRouterModelConfig>;
  modeByRole: Record<string, RoutingMode>;
}

export interface RoutingDecision {
  source: 'local' | 'openrouter';
  provider?: 'openrouter';
  model?: string;
  reason: string;
}

/** Per-(master, role) activity counters — what the sidecar's own UI renders
 *  as a "virtual container" row. Keyed the same way as `byMaster`: never
 *  merged or read across a different `serverUrl`. Holds no key material. */
interface StatsRecord {
  served: number;
  lastServedAt: number | null;
  lastDurationMs: number | null;
  totalTokens: number;
  failures: number;
  /** Message only — never anything key-derived. */
  lastError: string | null;
  /** Why the last attempt went cloud, e.g. the local-unavailable reason. */
  lastReason: string | null;
  /** >0 while a call is in flight — drives the 'serving' live state. */
  inFlight: number;
  lastOutcome: 'success' | 'failure' | null;
}

function emptyStats(): StatsRecord {
  return {
    served: 0,
    lastServedAt: null,
    lastDurationMs: null,
    totalTokens: 0,
    failures: 0,
    lastError: null,
    lastReason: null,
    inFlight: 0,
    lastOutcome: null,
  };
}

const G = processGlobal('virtual-inference', () => ({
  /** serverUrl -> config. Absent entry === local-only for every role. */
  byMaster: new Map<string, OpenRouterMasterConfig>(),
  /** serverUrl -> role -> activity counters. */
  statsByMaster: new Map<string, Map<string, StatsRecord>>(),
}));

function getOrCreateStats(serverUrl: string, role: string): StatsRecord {
  let byRole = G.statsByMaster.get(serverUrl);
  if (!byRole) {
    byRole = new Map();
    G.statsByMaster.set(serverUrl, byRole);
  }
  let rec = byRole.get(role);
  if (!rec) {
    rec = emptyStats();
    byRole.set(role, rec);
  }
  return rec;
}

function sanitizeAllowedModels(raw: unknown): Record<string, OpenRouterModelConfig> {
  const out: Record<string, OpenRouterModelConfig> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [role, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v) {
      out[role] = { model: v };
    } else if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (typeof obj.model === 'string' && obj.model) {
        out[role] = {
          model: obj.model,
          provider: typeof obj.provider === 'string' && obj.provider ? obj.provider : undefined,
          dims: typeof obj.dims === 'number' && obj.dims > 0 ? obj.dims : undefined,
          note: typeof obj.note === 'string' ? obj.note : undefined,
        };
      }
    }
  }
  return out;
}

function sanitizeModeByRole(raw: unknown): Record<string, RoutingMode> {
  const out: Record<string, RoutingMode> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [role, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && (VALID_MODES as string[]).includes(v)) {
      out[role] = v as RoutingMode;
    }
  }
  return out;
}

/**
 * Apply a master's OpenRouter config push. Mirrors the existing `case
 * 'config'` handling in ws-client.ts: partial pushes merge onto the
 * existing entry rather than replacing it, so a master can update just
 * `modeByRole` without re-sending the key.
 *
 * `payload` is untrusted network input — every field is validated before
 * use, and no exception here should ever surface the raw apiKey (it isn't
 * logged even on the happy path).
 */
export function setOpenRouterConfig(serverUrl: string, payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const obj = payload as Record<string, unknown>;

  const existing = G.byMaster.get(serverUrl);
  const apiKey = typeof obj.apiKey === 'string' && obj.apiKey ? obj.apiKey : existing?.apiKey;
  // A keyless push used to be discarded WHOLESALE — models and modes included.
  // That made re-push useless after a restart: the master cannot resend the
  // key (it never stores one), so every re-push was rejected and the operator
  // saw "delivered to 5/5" while nothing applied. Models and modes are not
  // secret and are worth keeping; without a key nothing can route to cloud
  // anyway, and resolveRouting enforces that below.
  if (!apiKey) {
    log.warn(`[${serverUrl}] OpenRouter config pushed with no apiKey (and none on file) — storing models/modes; cloud stays off until a key arrives`);
  }

  const allowedModels = obj.allowedModels !== undefined
    ? sanitizeAllowedModels(obj.allowedModels)
    : existing?.allowedModels ?? {};
  const modeByRole = obj.modeByRole !== undefined
    ? sanitizeModeByRole(obj.modeByRole)
    : existing?.modeByRole ?? {};

  G.byMaster.set(serverUrl, { apiKey, allowedModels, modeByRole });
  // Survive restarts. A self-update restarts this process, and without this
  // the whole fleet silently de-configures itself on every release.
  saveOpenRouterStore(G.byMaster as Map<string, { apiKey: string; allowedModels: Record<string, unknown>; modeByRole: Record<string, string> }>);

  const roleModes = Object.entries(modeByRole).map(([r, m]) => `${r}=${m}`).join(', ') || '(none set — all local-only)';
  const modeledRoles = Object.keys(allowedModels).join(', ') || '(none)';
  log.info(`[${serverUrl}] OpenRouter config updated — modes: ${roleModes}; models mapped for: ${modeledRoles}`);
}

/** Drop a master's OpenRouter config. Called when its slot is retired
 *  (ws-client.ts retireMaster) so a URL later reused by a different master
 *  process never inherits a stranger's key or allow-list. */
export function clearOpenRouterConfig(serverUrl: string): void {
  if (G.byMaster.delete(serverUrl)) {
    log.info(`[${serverUrl}] OpenRouter config cleared (master retired)`);
    // Persist the removal too, or a retired master's key would come back on
    // the next boot and a reused URL could inherit a stranger's credentials.
    saveOpenRouterStore(G.byMaster as Map<string, { apiKey: string; allowedModels: Record<string, unknown>; modeByRole: Record<string, string> }>);
  }
  G.statsByMaster.delete(serverUrl);
}

/** Restore persisted config at boot. Idempotent: an entry already in memory
 *  (a master that pushed before this ran) always wins over the stored copy. */
export function restoreOpenRouterConfig(): number {
  let restored = 0;
  for (const [url, cfg] of loadOpenRouterStore()) {
    if (G.byMaster.has(url)) continue;
    G.byMaster.set(url, cfg as never);
    restored++;
  }
  return restored;
}

/** Presence-only status for unauthenticated surfaces (/api/status, /api/config).
 *  NEVER include the key or any prefix of it here. */
export function getOpenRouterStatus(serverUrl: string): {
  /** 'configured' = usable. 'key-missing' = models/modes stored but no key, so
   *  every role resolves local until one arrives — distinct from 'unset' so the
   *  master can say "re-enter the key" instead of "nothing was ever pushed". */
  openrouter: 'configured' | 'key-missing' | 'unset';
  modeByRole: Record<string, RoutingMode>;
  rolesWithModel: string[];
} {
  const cfg = G.byMaster.get(serverUrl);
  return {
    openrouter: !cfg ? 'unset' : (cfg.apiKey ? 'configured' : 'key-missing'),
    modeByRole: cfg?.modeByRole ?? {},
    rolesWithModel: cfg ? Object.keys(cfg.allowedModels) : [],
  };
}

function modeFor(cfg: OpenRouterMasterConfig | undefined, role: string): RoutingMode {
  return cfg?.modeByRole?.[role] ?? 'local-only';
}

/** One row of the sidecar's own "Virtual Containers" UI — a (master, role)
 *  pair that has a model mapped, whether or not it has ever been served.
 *  Key hygiene unchanged: no field here is or derives from the API key. */
export interface VirtualContainerInfo {
  serverUrl: string;
  role: string;
  model: string;
  provider?: string;
  dims?: number;
  mode: RoutingMode;
  served: number;
  lastServedAt: number | null;
  lastDurationMs: number | null;
  totalTokens: number;
  failures: number;
  lastError: string | null;
  lastReason: string | null;
  state: 'idle' | 'serving' | 'failed';
}

/** Activity for every role this master has mapped a model for — the data
 *  behind the sidecar UI's "Virtual Containers" section. Empty array when
 *  the master hasn't pushed an OpenRouter config, or has pushed one with no
 *  models mapped. Scoped to `serverUrl` like everything else in this module. */
export function getVirtualContainerStats(serverUrl: string): VirtualContainerInfo[] {
  const cfg = G.byMaster.get(serverUrl);
  if (!cfg) return [];
  const byRole = G.statsByMaster.get(serverUrl);
  const out: VirtualContainerInfo[] = [];
  for (const [role, modelCfg] of Object.entries(cfg.allowedModels)) {
    const rec = byRole?.get(role);
    const { provider, dims } = resolveModelDetails(modelCfg);
    out.push({
      serverUrl,
      role,
      model: modelCfg.model,
      provider,
      dims,
      mode: modeFor(cfg, role),
      served: rec?.served ?? 0,
      lastServedAt: rec?.lastServedAt ?? null,
      lastDurationMs: rec?.lastDurationMs ?? null,
      totalTokens: rec?.totalTokens ?? 0,
      failures: rec?.failures ?? 0,
      lastError: rec?.lastError ?? null,
      lastReason: rec?.lastReason ?? null,
      state: rec && rec.inFlight > 0 ? 'serving' : rec?.lastOutcome === 'failure' ? 'failed' : 'idle',
    });
  }
  return out;
}

/**
 * Resolve where a role's inference should run for a given master.
 *
 * Called from handleAcquire (handlers.ts) on BOTH paths:
 *   - before attempting local start, for `cloud-only` roles (skip local
 *     entirely — no container start, no host-Ollama probe);
 *   - after a local start/probe FAILS, for `local-first` roles, passing the
 *     local error as `localErrorReason` so the fallback log line says why.
 *
 * `local-only` (the default for every role on every master, including one
 * with no OpenRouter config at all) never routes to OpenRouter — this
 * function is a pure read and never makes a network call itself; the actual
 * OpenRouter request is made by the MASTER (which already calls out for DMR
 * inference directly — see CLAUDE.md's Docker Model Runner section), not the
 * sidecar. The sidecar's job is the decision and the log line.
 */
export function resolveRouting(params: {
  role: string;
  serverUrl: string;
  /** Only meaningful for the local-first fallback check; ignored for cloud-only. */
  localAvailable?: boolean;
  localErrorReason?: string;
  /** Optional per-call detail appended to the log line, e.g. "12 docs". */
  detail?: string;
}): RoutingDecision {
  const { role, serverUrl, detail } = params;
  const cfg = G.byMaster.get(serverUrl);
  const mode = modeFor(cfg, role);
  const modelCfg = cfg?.allowedModels?.[role];
  const detailSuffix = detail ? ` (${detail})` : '';

  if (!cfg?.apiKey) {
    return { source: 'local', reason: 'no OpenRouter key on file for this master' };
  }
  if (mode === 'local-only') {
    return { source: 'local', reason: 'local-only (default)' };
  }

  if (mode === 'cloud-only') {
    if (!modelCfg) {
      log.warn(
        `[${serverUrl}] role "${role}" is cloud-only but no OpenRouter model is mapped for it — ` +
        `falling back to local (misconfiguration)`,
      );
      return { source: 'local', reason: 'cloud-only but no model mapped — falling back to local' };
    }
    const modelLabel = modelCfg.note ? `${modelCfg.model} (${modelCfg.note})` : modelCfg.model;
    log.info(`[virtual-inference] [${serverUrl}] ${role} via OpenRouter ${modelLabel}${detailSuffix} — cloud-only`);
    return { source: 'openrouter', provider: 'openrouter', model: modelCfg.model, reason: 'cloud-only' };
  }

  // local-first
  if (params.localAvailable !== false) {
    log.info(`[virtual-inference] [${serverUrl}] local ${role} available — using local`);
    return { source: 'local', reason: 'local available' };
  }
  if (!modelCfg) {
    log.warn(
      `[${serverUrl}] role "${role}" is local-first and local is unavailable, but no OpenRouter model ` +
      `is mapped for it — no fallback possible`,
    );
    return { source: 'local', reason: 'local unavailable and no OpenRouter model mapped' };
  }
  const modelLabel = modelCfg.note ? `${modelCfg.model} (${modelCfg.note})` : modelCfg.model;
  const why = params.localErrorReason ? ` — local ${role} unavailable: ${params.localErrorReason}` : ` — local ${role} unavailable`;
  log.info(`[virtual-inference] [${serverUrl}] ${role} via OpenRouter ${modelLabel}${detailSuffix}${why}`);
  return { source: 'openrouter', provider: 'openrouter', model: modelCfg.model, reason: `local-first fallback${why}` };
}

/** True when the master has configured cloud-only for this role — lets
 *  callers skip a local start/probe attempt entirely instead of paying for
 *  a doomed container start before falling back. */
export function isCloudOnly(role: string, serverUrl: string): boolean {
  return modeFor(G.byMaster.get(serverUrl), role) === 'cloud-only';
}

function resolveModelDetails(modelCfg: OpenRouterModelConfig): { provider?: string; dims?: number } {
  return {
    provider: modelCfg.provider ?? KNOWN_PROVIDER_PINS[modelCfg.model],
    dims: modelCfg.dims ?? KNOWN_DIMS[modelCfg.model],
  };
}

function formatModelLabel(modelCfg: OpenRouterModelConfig, dims?: number): string {
  if (modelCfg.note) return `${modelCfg.model} (${modelCfg.note})`;
  if (dims) return `${modelCfg.model} (${dims}d)`;
  return modelCfg.model;
}

export interface ServeEmbeddingParams {
  role: string;
  serverUrl: string;
  texts: string[];
  /** Only meaningful for the local-first fallback check; ignored for cloud-only. */
  localAvailable?: boolean;
  localErrorReason?: string;
  /** If the caller names a specific model, it MUST match this master's
   *  allow-listed model for the role. A mismatch is refused outright — never
   *  silently substituted, and never served from another master's allow-list
   *  even if that master permits it. */
  requestedModel?: string;
}

export type ServeEmbeddingResult =
  | { source: 'local' }
  | { source: 'openrouter'; embeddings: number[][]; model: string; dims: number; totalTokens?: number };

/**
 * Actually SERVE an embedding request via OpenRouter when routing says to —
 * this is what makes the per-master key useful, rather than a decision the
 * sidecar hands back for someone else to execute. Returns `{source:'local'}`
 * when the decision is to stay local (the caller — handlers.ts — then uses
 * the ordinary local Ollama/DMR path); makes and awaits the real OpenRouter
 * call only when the decision is `openrouter`.
 */
export async function serveEmbedding(params: ServeEmbeddingParams): Promise<ServeEmbeddingResult> {
  const { role, serverUrl, texts } = params;
  const decision = resolveRouting({
    role,
    serverUrl,
    localAvailable: params.localAvailable,
    localErrorReason: params.localErrorReason,
    detail: `${texts.length} chunk${texts.length === 1 ? '' : 's'}`,
  });
  if (decision.source !== 'openrouter') return { source: 'local' };

  const cfg = G.byMaster.get(serverUrl);
  const modelCfg = cfg?.allowedModels?.[role];
  // Defensive — resolveRouting only ever returns 'openrouter' when both of
  // these exist, so this is unreachable in practice, not a real fallback.
  if (!cfg || !modelCfg) return { source: 'local' };

  const rec = getOrCreateStats(serverUrl, role);
  rec.lastReason = decision.reason;

  if (params.requestedModel && params.requestedModel !== modelCfg.model) {
    const message = `Model "${params.requestedModel}" is not allow-listed for role "${role}" on this master`;
    rec.failures++;
    rec.lastError = message;
    rec.lastOutcome = 'failure';
    log.error(
      `[${serverUrl}] REFUSED embedding request for role "${role}": caller asked for model ` +
      `"${params.requestedModel}" but this master's allow-list maps "${role}" to "${modelCfg.model}" — ` +
      `a model outside the requesting master's own allow-list is never served, even when another ` +
      `master's allow-list would permit it`,
    );
    throw new Error(message);
  }

  const { provider, dims } = resolveModelDetails(modelCfg);
  if (!provider) {
    log.error(
      `[${serverUrl}] REFUSED embedding via OpenRouter ${modelCfg.model} for role "${role}" — no provider ` +
      `pin known or configured for this model; an unpinned embedding call can silently split the vector ` +
      `space across providers, so this always fails closed to local rather than guessing`,
    );
    // Fails closed to local, not a served failure — no counter bump; the
    // request still completes (locally), it's a misconfiguration to fix.
    return { source: 'local' };
  }

  const label = formatModelLabel(modelCfg, dims);
  const startedAt = Date.now();
  rec.inFlight++;
  try {
    // resolveRouting only returns 'openrouter' when a key is on file; assert it
    // rather than trusting a caller ordering that could change.
    if (!cfg.apiKey) throw new Error('no OpenRouter key on file for this master');
    const result = await orEmbed(cfg.apiKey, texts, modelCfg.model, { pinProvider: provider, expectedDims: dims });
    const ms = Date.now() - startedAt;
    log.info(
      `[virtual-inference] [${serverUrl}] embedding via OpenRouter ${label} completed in ${ms}ms ` +
      `(${result.totalTokens ?? '?'} tokens, ${result.vectors.length} vector${result.vectors.length === 1 ? '' : 's'})`,
    );
    rec.served++;
    rec.lastServedAt = Date.now();
    rec.lastDurationMs = ms;
    rec.totalTokens += result.totalTokens ?? 0;
    rec.lastOutcome = 'success';
    return {
      source: 'openrouter',
      embeddings: result.vectors,
      model: modelCfg.model,
      dims: result.dims,
      totalTokens: result.totalTokens,
    };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const message = (err as Error).message;
    log.error(`[virtual-inference] [${serverUrl}] embedding via OpenRouter ${label} FAILED after ${ms}ms: ${message}`);
    rec.failures++;
    rec.lastDurationMs = ms;
    rec.lastError = message;
    rec.lastOutcome = 'failure';
    throw err;
  } finally {
    rec.inFlight--;
  }
}

export interface ServeRerankParams {
  role: string;
  serverUrl: string;
  query: string;
  documents: string[];
  topN?: number;
  localAvailable?: boolean;
  localErrorReason?: string;
  requestedModel?: string;
}

export type ServeRerankResult =
  | { source: 'local' }
  | { source: 'openrouter'; results: Array<{ index: number; relevance_score: number }>; model: string; totalTokens?: number };

/** Same contract as serveEmbedding, for rerank. No provider pin required —
 *  rerank is stateless, unlike an embedding vector space. */
export async function serveRerank(params: ServeRerankParams): Promise<ServeRerankResult> {
  const { role, serverUrl, query, documents } = params;
  const decision = resolveRouting({
    role,
    serverUrl,
    localAvailable: params.localAvailable,
    localErrorReason: params.localErrorReason,
    detail: `${documents.length} doc${documents.length === 1 ? '' : 's'}`,
  });
  if (decision.source !== 'openrouter') return { source: 'local' };

  const cfg = G.byMaster.get(serverUrl);
  const modelCfg = cfg?.allowedModels?.[role];
  if (!cfg || !modelCfg) return { source: 'local' };

  const rec = getOrCreateStats(serverUrl, role);
  rec.lastReason = decision.reason;

  if (params.requestedModel && params.requestedModel !== modelCfg.model) {
    const message = `Model "${params.requestedModel}" is not allow-listed for role "${role}" on this master`;
    rec.failures++;
    rec.lastError = message;
    rec.lastOutcome = 'failure';
    log.error(
      `[${serverUrl}] REFUSED rerank request for role "${role}": caller asked for model ` +
      `"${params.requestedModel}" but this master's allow-list maps "${role}" to "${modelCfg.model}" — ` +
      `a model outside the requesting master's own allow-list is never served, even when another ` +
      `master's allow-list would permit it`,
    );
    throw new Error(message);
  }

  const label = modelCfg.note ? `${modelCfg.model} (${modelCfg.note})` : modelCfg.model;
  const startedAt = Date.now();
  rec.inFlight++;
  try {
    if (!cfg.apiKey) throw new Error('no OpenRouter key on file for this master');
    const result = await orRerank(cfg.apiKey, query, documents, modelCfg.model, { topN: params.topN });
    const ms = Date.now() - startedAt;
    log.info(
      `[virtual-inference] [${serverUrl}] rerank via OpenRouter ${label} completed in ${ms}ms ` +
      `(${result.totalTokens ?? '?'} tokens, ${result.results.length} scored)`,
    );
    rec.served++;
    rec.lastServedAt = Date.now();
    rec.lastDurationMs = ms;
    rec.totalTokens += result.totalTokens ?? 0;
    rec.lastOutcome = 'success';
    return { source: 'openrouter', results: result.results, model: modelCfg.model, totalTokens: result.totalTokens };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const message = (err as Error).message;
    log.error(`[virtual-inference] [${serverUrl}] rerank via OpenRouter ${label} FAILED after ${ms}ms: ${message}`);
    rec.failures++;
    rec.lastDurationMs = ms;
    rec.lastError = message;
    rec.lastOutcome = 'failure';
    throw err;
  } finally {
    rec.inFlight--;
  }
}

/** Test seam. */
/**
 * Return the OpenRouter key's own rate limit / spend metadata for this master.
 *
 * Deliberately NOT gated on any role's routing mode. Credits and the account
 * rate limit are properties of the KEY, not of a role: a master running every
 * role local still has a balance worth reading, and it needs the ceiling
 * BEFORE it decides how hard to push the cloud. Gating this on mode is what
 * made the master report "no virtual containers registered" while showing
 * fifteen of them.
 *
 * Only requires that this master has pushed a key. The upstream envelope is
 * passed through untouched; the key never appears in the result.
 */
export async function serveKeyInfo(serverUrl: string): Promise<Record<string, unknown>> {
  const cfg = G.byMaster.get(serverUrl);
  if (!cfg?.apiKey) {
    return { error: `no OpenRouter key configured for master ${serverUrl}` };
  }
  try {
    return await orKeyInfo(cfg.apiKey);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export function __resetVirtualInferenceForTest(): void {
  G.byMaster.clear();
  G.statsByMaster.clear();
}
