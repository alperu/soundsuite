/**
 * Shared dependency factories for MCP tools.
 *
 * Centralises dependency checks so that all tools referencing the same
 * external resource use a single, consistent check.
 */

import { ToolDependency } from './tool-types';

/**
 * LLM provider dependency.
 * Checks that at least ONE AI provider key is configured (Groq, OpenAI, Anthropic, Grok, or Ollama).
 * Tools need an LLM to function but are not locked to a single provider.
 */
export function llmProviderDependency(): ToolDependency {
  return {
    key: 'llmProvider',
    label: 'AI Provider Key (any)',
    required: true,
    check: async () => {
      // Check env vars first
      if (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.OLLAMA_HOST) return true;
      try {
        const { prisma } = await import('../db/prisma');
        const keys = await prisma.config.findMany({
          where: {
            key: {
              in: ['ai.groqApiKey', 'embedding.openaiApiKey', 'embedding.claudeApiKey', 'ai.geminiApiKey', 'ai.grokApiKey', 'ai.ollamaHost'],
            },
          },
        });
        return keys.some(k => !!k.value);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Groq API key dependency (kept for backward compat / explicit Groq-only tools).
 * Checks both env var and persisted config in the database.
 */
export function groqApiKeyDependency(): ToolDependency {
  return {
    key: 'groqApiKey',
    label: 'Groq API Key',
    required: true,
    check: async () => {
      if (process.env.GROQ_API_KEY) return true;
      try {
        const { prisma } = await import('../db/prisma');
        const row = await prisma.config.findUnique({ where: { key: 'ai.groqApiKey' } });
        return !!row?.value;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ollama readiness probe (local-profile gating)
// ---------------------------------------------------------------------------

const OLLAMA_PROBE_TIMEOUT_MS = 3_000;
/** Generation smoke: a wedged or queued model must answer a 5-token prompt in this window. */
const OLLAMA_GENERATE_TIMEOUT_MS = 10_000;
/** Readiness (tags + generation smoke) is cached this long — the smoke runs at most once per window. */
const OLLAMA_PROBE_CACHE_MS = 60_000;

/**
 * Consecutive failed smokes required before readiness flips to not-ready
 * (report N-4). One success recovers immediately.
 */
export const OLLAMA_FAILURE_THRESHOLD = 2;

export interface OllamaReadiness {
  /** `GET /api/tags` answered 200. */
  reachable: boolean;
  /** The completion model produced a response to a tiny prompt within 10 s. */
  generates: boolean;
  /** Completion model the smoke ran against (empty when none is configured). */
  model: string;
  /** Why `reachable && generates` is false, for tool `readyReasons`. */
  reason?: string;
  /**
   * The raw probe failed but a last-known-good result is still being served
   * (hysteresis). `reachable`/`generates` are the last-known-good values, not
   * the values the failing probe returned — so tools stay visible.
   */
  degraded?: boolean;
  /** Consecutive raw-probe failures observed so far (0 when the last probe passed). */
  pendingFailures?: number;
  /** The failing probe's reason, while `degraded`. */
  pendingReason?: string;
}

// ---------------------------------------------------------------------------
// Readiness hysteresis (report N-4)
// ---------------------------------------------------------------------------

/**
 * Turns a stream of raw probe results into a readiness signal that does not
 * flap.
 *
 * - N consecutive failures (default 2) before reporting not-ready.
 * - A single success recovers immediately.
 * - In between, the last-known-good result is served, flagged `degraded`.
 * - Cold start (no last-known-good yet) reports the failure straight away —
 *   there is nothing honest to serve instead.
 */
export class ReadinessHysteresis {
  private lastGood: OllamaReadiness | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly threshold: number = OLLAMA_FAILURE_THRESHOLD) {}

  observe(raw: OllamaReadiness): OllamaReadiness {
    if (raw.reachable && raw.generates) {
      this.consecutiveFailures = 0;
      this.lastGood = { reachable: raw.reachable, generates: raw.generates, model: raw.model };
      return { ...this.lastGood, degraded: false, pendingFailures: 0 };
    }

    this.consecutiveFailures += 1;
    if (this.lastGood && this.consecutiveFailures < this.threshold) {
      return {
        ...this.lastGood,
        degraded: true,
        pendingFailures: this.consecutiveFailures,
        pendingReason: raw.reason,
      };
    }
    this.lastGood = null;
    return { ...raw, degraded: false, pendingFailures: this.consecutiveFailures };
  }

  /** Serialisable state, so the machine survives a module re-evaluation. */
  snapshot(): { lastGood: OllamaReadiness | null; consecutiveFailures: number } {
    return { lastGood: this.lastGood, consecutiveFailures: this.consecutiveFailures };
  }

  restore(state: { lastGood: OllamaReadiness | null; consecutiveFailures: number } | undefined | null): void {
    if (!state) return;
    this.lastGood = state.lastGood;
    this.consecutiveFailures = state.consecutiveFailures;
  }

  reset(): void {
    this.lastGood = null;
    this.consecutiveFailures = 0;
  }
}

/**
 * Probe cache and hysteresis state live on `globalThis`, not in module scope.
 *
 * Under dev HMR (and whenever two evaluations of this module coexist) a
 * module-level cache is empty for the new instance, so the cold-start rule
 * would fire and readiness would flip to not-ready on a single failed smoke —
 * which is exactly the flap N-4 observed. Keyed state survives that.
 */
const globalForReadiness = globalThis as unknown as {
  __mcpOllamaProbe?: { at: number; result: OllamaReadiness } | null;
  __mcpOllamaHysteresis?: { lastGood: OllamaReadiness | null; consecutiveFailures: number };
};

let _ollamaProbeInflight: Promise<OllamaReadiness> | null = null;

function loadHysteresis(): ReadinessHysteresis {
  const machine = new ReadinessHysteresis();
  machine.restore(globalForReadiness.__mcpOllamaHysteresis);
  return machine;
}

function saveHysteresis(machine: ReadinessHysteresis): void {
  globalForReadiness.__mcpOllamaHysteresis = machine.snapshot();
}

function ollamaBase(config: { ollamaCompletionHost?: string; ollamaHost?: string }): string {
  const host = (config.ollamaCompletionHost || config.ollamaHost || process.env.OLLAMA_HOST || '').trim();
  if (!host) return '';
  return (host.startsWith('http') ? host : `http://${host}`).replace(/\/+$/, '');
}

async function resolveCompletionModel(config: { ollamaCompletionModel?: string }): Promise<string> {
  if (config.ollamaCompletionModel?.trim()) return config.ollamaCompletionModel.trim();
  try {
    const { DEFAULT_MODELS } = await import('./tools/ai-helper');
    return DEFAULT_MODELS.ollama;
  } catch {
    return '';
  }
}

async function probeOllama(): Promise<OllamaReadiness> {
  let config: { ollamaCompletionHost?: string; ollamaHost?: string; ollamaCompletionModel?: string } = {};
  try {
    const { getConfig } = await import('../db/config');
    config = await getConfig();
  } catch {
    config = {};
  }
  const base = ollamaBase(config);
  const model = await resolveCompletionModel(config);
  if (!base) return { reachable: false, generates: false, model, reason: 'no Ollama host configured' };

  // 1. Reachability — /api/tags.
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS) });
    if (!res.ok) return { reachable: false, generates: false, model, reason: `${base}/api/tags returned HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { reachable: false, generates: false, model, reason: `${base} unreachable (${msg.slice(0, 120)})` };
  }
  if (!model) return { reachable: true, generates: false, model, reason: 'no Ollama completion model configured' };

  // 2. Generation smoke — a tiny prompt must complete within 10 s. /api/tags
  //    says nothing about whether the runner can actually produce tokens
  //    (wedged runner, queue backed up behind long requests, cold load that
  //    never finishes).
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'OK', stream: false, options: { num_predict: 5 } }),
      signal: AbortSignal.timeout(OLLAMA_GENERATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { reachable: true, generates: false, model, reason: `${model} generate returned HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}` };
    }
    const body = (await res.json().catch(() => ({}))) as { done?: boolean; error?: string };
    if (body.error) return { reachable: true, generates: false, model, reason: `${model} generate error: ${String(body.error).slice(0, 120)}` };
    if (body.done === false) return { reachable: true, generates: false, model, reason: `${model} did not finish generating within ${OLLAMA_GENERATE_TIMEOUT_MS / 1000} s` };
    return { reachable: true, generates: true, model };
  } catch (err) {
    const name = (err as Error)?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError' || Date.now() - t0 >= OLLAMA_GENERATE_TIMEOUT_MS - 50;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      reachable: true,
      generates: false,
      model,
      reason: timedOut
        ? `ollama reachable but ${model} did not generate within ${OLLAMA_GENERATE_TIMEOUT_MS / 1000} s`
        : `ollama reachable but ${model} failed to generate (${msg.slice(0, 120)})`,
    };
  }
}

/**
 * Ollama readiness for the `local` profile. Reads the same config the MCP AI
 * helper uses (`ollamaCompletionHost || ollamaHost`), checks `GET /api/tags`
 * (3 s) and then — at most once per 60 s — runs a 5-token generation smoke
 * against the configured completion model (10 s). Cached for 60 s; concurrent
 * callers share one in-flight probe. Never throws.
 *
 * The raw probe result goes through `ReadinessHysteresis` before it is
 * returned or cached: one failed smoke leaves readiness at its last-known-good
 * value with `degraded: true`, two consecutive failures flip it (N-4).
 */
export async function ollamaReadiness(opts?: { force?: boolean }): Promise<OllamaReadiness> {
  const now = Date.now();
  const cached = globalForReadiness.__mcpOllamaProbe;
  if (!opts?.force && cached && now - cached.at < OLLAMA_PROBE_CACHE_MS) {
    return cached.result;
  }
  if (_ollamaProbeInflight) return _ollamaProbeInflight;

  _ollamaProbeInflight = (async () => {
    let raw: OllamaReadiness;
    try {
      raw = await probeOllama();
    } catch (err) {
      raw = { reachable: false, generates: false, model: '', reason: err instanceof Error ? err.message : String(err) };
    }
    const machine = loadHysteresis();
    const result = machine.observe(raw);
    saveHysteresis(machine);
    globalForReadiness.__mcpOllamaProbe = { at: Date.now(), result };
    _ollamaProbeInflight = null;
    return result;
  })();

  return _ollamaProbeInflight;
}

/**
 * Is Ollama usable — reachable AND able to generate? Wrapper over
 * `ollamaReadiness()`; same cache.
 *
 * The `local` profile pins LLM tools to Ollama; when this returns false those
 * tools report `ready: false` and the bridge hides them rather than falling
 * back to a cloud provider.
 */
export async function ollamaAvailable(opts?: { force?: boolean }): Promise<boolean> {
  const r = await ollamaReadiness(opts);
  return r.reachable && r.generates;
}

/** Test hook — drop the cached probe result and the hysteresis state. */
export function resetOllamaProbeCache(): void {
  globalForReadiness.__mcpOllamaProbe = null;
  globalForReadiness.__mcpOllamaHysteresis = undefined;
  _ollamaProbeInflight = null;
}

/**
 * Vector store dependency.
 * Always returns true (the registry sets it up during init).
 */
export function vectorStoreDependency(): ToolDependency {
  return {
    key: 'vectorStore',
    label: 'Vector Store',
    required: true,
    check: async () => true,
  };
}
