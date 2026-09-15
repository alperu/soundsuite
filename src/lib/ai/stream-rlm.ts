/**
 * Stream from ss-rlm (Recursive Language Model) — Qwen3-8B post-trained — by
 * hitting the vLLM container's OpenAI-compatible /v1/chat/completions on a
 * sidecar that has `containers.rlm.status === 'running'`.
 *
 * Two entry points:
 *   - streamRlm()          — Phase A. Plain SSE chat. No tool calls.
 *   - runRlmWithTools()    — Phase B. Tool-use loop. RLM emits tool_calls,
 *                            caller invokes tools, results fed back. Final
 *                            assistant turn streams normally.
 *
 * Discovery mirrors src/lib/search/reranker.ts.
 */

// Static import: models.ts is a pure data module with no side effects and no
// 'server-only' marker, so it costs nothing here and keeps hostedContextBudget
// synchronous (the budget is needed inside resolveRlmEndpoint's hot path).
import { findChatModel } from '@/lib/openrouter/models';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface RlmToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ResolvedRlmEndpoint {
  endpoint: string;
  host: string;
  /** True when this endpoint is ss-rlm-sandbox (hosted-pattern fallback),
   *  not the self-hosted ss-rlm vLLM container. Callers use this to pick
   *  the right model id and to make the degraded path visible in logs/UI —
   *  see resolveRlmEndpoint()'s Phase 2 below. */
  sandbox?: boolean;
  /** Only set when sandbox === true: the operator-configured OpenRouter
   *  chat-model id (rlm.sandboxModel) the sandbox should drive. */
  model?: string;
  /**
   * Total context window (input + output) to budget this endpoint against.
   *
   * Resolved here rather than at the call sites because there are two of them
   * (`streamRlm` and `runRlmWithTools`) and a budget that differs between them
   * is a 400 waiting to happen. Always set: the self-hosted path carries
   * RLM_CONTEXT_TOKENS, the sandbox path the hosted model's own window.
   */
  contextTokens: number;
}

export interface StreamRlmEvent {
  type: 'token' | 'done' | 'error';
  text?: string;
  content?: string;
  usage?: { inputTokens: number; outputTokens: number };
  provider?: string;
  model?: string;
  message?: string;
}

const RLM_PORT = 8100;
// ss-rlm-sandbox — see sideCar/src/lib/state.ts:defaultRegistry['rlm-sandbox'].
//
// TODO(host-side proxy / Fantom HTTP tool exposure — design note steps 3-4,
// explicitly out of scope here): this code assumes the sandbox exposes the
// same OpenAI-compatible `/v1/chat/completions` surface as ss-rlm and that
// tool_calls round-trip through it exactly like the vLLM path below. Neither
// is built yet. Once the sandbox's actual HTTP contract exists, verify that
// assumption here (and in streamRlm/runRlmWithTools's fetch calls) rather
// than trusting it.
//
// RESOLVED (the context-budget half of this TODO): the sandbox path no longer
// reuses ss-rlm's 40960 vLLM ceiling. `ResolvedRlmEndpoint.contextTokens` now
// carries the hosted model's own window — see hostedContextBudget() below.
// The HTTP-contract assumption above is still outstanding.
const RLM_SANDBOX_PORT = 8101;

/**
 * Header naming the calling master, sent only on the ss-rlm-sandbox path.
 *
 * The sandbox makes sub-model calls back through its sidecar, and `apiKey`,
 * `allowedModels` and the spend are all **per master** so Sound Suite and
 * Fantom cannot charge each other. Over a WebSocket the sidecar gets the
 * caller's identity for free; over HTTP it has none, so it refuses with 409
 * rather than guess whose budget to spend.
 *
 * That refusal is not theoretical: as of 2026-09-16 every sidecar has keys from
 * BOTH masters (:3000 Sound Suite and :3848 Fantom), so without this header the
 * sandbox path returns 409 on every host.
 *
 * Matches `x-soundsuite-master` in
 * sideCar/src/app/api/v1/chat/completions/route.ts. Distinct from
 * MASTER_URL_HEADER in master-identity.ts, which identifies the master to a
 * sidecar's own endpoints; this one is forwarded *through* the sandbox.
 */
const SANDBOX_MASTER_HEADER = 'X-SoundSuite-Master';

/**
 * This master's retrieval domain, restated per request.
 *
 * The AUTHORITATIVE declaration is `domain: 'legal'` in the config push
 * (`buildOpenRouterPush`), which the sidecar stores per master. This header
 * restates it on the unit that actually selects tools: the container picks the
 * REPL tool set per request, and it can only see headers — the stored config
 * lives on the sidecar, which the container never queries.
 *
 * Hardcoded, like the push. Which retrieval domain this software operates over
 * is a fact about the software, not an operator preference, and a wrong value
 * does not error — it answers a legal question with code retrieval.
 *
 * Fantom sends the same pair under an `X-FantomMCP-` prefix; both sides accept
 * both spellings so neither has to redeploy in lockstep.
 */
const SANDBOX_DOMAIN_HEADER = 'X-SoundSuite-Domain';
const SANDBOX_DOMAIN = 'legal';

/**
 * Headers for a request to an RLM endpoint. Adds the caller identity only for
 * the sandbox — the self-hosted ss-rlm vLLM server has no use for it and would
 * just log an unknown header.
 */
async function rlmHeaders(resolved: ResolvedRlmEndpoint): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!resolved.sandbox) return headers;
  // Domain is a constant — send it even if identity resolution fails below, so
  // a master that cannot name itself still gets the right tools rather than
  // none.
  headers[SANDBOX_DOMAIN_HEADER] = SANDBOX_DOMAIN;
  try {
    const { getCanonicalMasterUrl } = await import('@/lib/gpu/master-identity');
    const self = await getCanonicalMasterUrl();
    if (self) headers[SANDBOX_MASTER_HEADER] = self;
    else console.warn('[RLM] sandbox call without a canonical master URL — the sidecar will 409 if more than one master has a key');
  } catch (err) {
    console.warn(`[RLM] could not resolve this master's URL for the sandbox header: ${(err as Error).message}`);
  }
  return headers;
}
export const RLM_MODEL_ID = 'mit-oasys/rlm-qwen3-8b-v0.1';

// ──────────────────────────────────────────────────────────────────────────
// Context budgeting — vLLM rejects requests where prompt_tokens +
// max_tokens > max_model_len. The current RLM (Qwen3-8B) is served with
// --max-model-len 40960 (the model's native max_position_embeddings; raised
// from 32768; fp8 KV cache — see sideCar mode-templates.ts / state.ts). The
// tool-use loop accumulates 80+ chunk-sized
// payloads across rounds, easily crossing the ceiling by round 2 when
// max_tokens=4096 is requested unconditionally (we crashed at 32769 on a
// real run — see /Users/alper/.../logs/dashboard.log).
//
// We defend in three steps each round:
//  1. Estimate the input-token cost of `messages` (char/3.2 — matches the
//     ratio observed on Qwen3-8B for mixed legal text + JSON chunks).
//  2. Clamp `max_tokens` so input + output + safety margin fits the ctx.
//  3. If even MIN_OUTPUT_TOKENS doesn't fit, trim the oldest
//     assistant+tool group(s) (preserving system + user) until it does.
//
// The clamp + trim are logged so operators can see what happened, and the
// retry-stream path uses the same numbers as the main loop.
// ──────────────────────────────────────────────────────────────────────────
export const RLM_CONTEXT_TOKENS = 40960;
export const TOKEN_CHAR_RATIO = 3.2;
export const SAFETY_MARGIN_TOKENS = 256;
export const MIN_OUTPUT_TOKENS = 768;

/**
 * Fraction of a hosted model's advertised window we will actually budget.
 *
 * SAFETY_MARGIN_TOKENS (256) and TOKEN_CHAR_RATIO (3.2) were both tuned
 * against the 40960 vLLM ceiling, where 256 tokens is a 0.6% cushion. Against
 * DeepSeek's 1,048,576 the same constant is 0.025%, and the char/token ratio
 * is calibrated for Qwen's tokenizer, not DeepSeek's. A 10% estimator error
 * costs 4k tokens at 40960 — the clamp absorbs it — but 105k at 1M, which is
 * a provider-side 400: exactly the failure this module exists to prevent,
 * on the path with the least production exposure.
 *
 * So the advertised figure is scaled rather than used raw. This is a
 * deliberately blunt instrument; a real tokenizer would let it go away.
 */
export const HOSTED_CONTEXT_UTILIZATION = 0.9;

/**
 * Context budget for a hosted (sandbox) model id.
 *
 * `rlm.sandboxModel` is free-form — `/api/openrouter/settings` accepts any
 * string without checking it against the catalogue — so an id we do not know
 * is a real path, not a defensive branch. Falling back to RLM_CONTEXT_TOKENS
 * is the conservative choice: too small only over-trims, while guessing too
 * large is a 400.
 */
export function hostedContextBudget(modelId: string): number {
  const known = findChatModel(modelId)?.contextTokens;
  return known ? Math.floor(known * HOSTED_CONTEXT_UTILIZATION) : RLM_CONTEXT_TOKENS;
}

export function estimateInputTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    // Tool-call JSON is part of the prompt too — include it.
    const tc = (m as any).tool_calls;
    if (Array.isArray(tc)) {
      for (const c of tc) {
        try {
          chars += JSON.stringify(c).length;
        } catch {
          /* defensive — circular refs shouldn't happen here */
        }
      }
    }
  }
  return Math.ceil(chars / TOKEN_CHAR_RATIO);
}

export function clampOutputTokens(
  messages: ChatMessage[],
  requested: number,
  contextTokens: number = RLM_CONTEXT_TOKENS,
): { maxTokens: number; clamped: boolean; estimatedInput: number; needsInputTrim: boolean } {
  const estimatedInput = estimateInputTokens(messages);
  // The invariant vLLM enforces: estimatedInput + maxTokens + SAFETY_MARGIN must
  // stay within RLM_CONTEXT_TOKENS. `ceil` is the largest max_tokens that
  // satisfies it. NEVER return a value above `ceil` — the previous code returned
  // MIN_OUTPUT_TOKENS even when ceil was smaller, which is what 400'd vLLM
  // (e.g. estimatedInput=40193 → ceil=511 but it sent max_tokens=768 → 40961 >
  // 40960). When ceil < MIN_OUTPUT_TOKENS the input is too large for a useful
  // answer and the CALLER must trim input (needsInputTrim) before sending.
  const ceil = contextTokens - estimatedInput - SAFETY_MARGIN_TOKENS;
  if (ceil < MIN_OUTPUT_TOKENS) {
    return { maxTokens: Math.max(1, ceil), clamped: true, estimatedInput, needsInputTrim: true };
  }
  const maxTokens = Math.min(requested, ceil);
  return { maxTokens, clamped: maxTokens < requested, estimatedInput, needsInputTrim: false };
}

/**
 * When estimatedInput + MIN_OUTPUT_TOKENS doesn't fit even after clamping,
 * trim the oldest assistant message and its trailing tool messages.
 * Preserves messages[0] (system) and messages[1] (the initial user turn).
 * Returns the number of messages removed.
 */
export function trimHistoryToFit(
  messages: ChatMessage[],
  contextTokens: number = RLM_CONTEXT_TOKENS,
): number {
  let removed = 0;
  while (true) {
    const estimatedInput = estimateInputTokens(messages);
    if (estimatedInput + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS <= contextTokens) break;
    let assistantIdx = -1;
    for (let i = 2; i < messages.length - 1; i++) {
      if (messages[i].role === 'assistant') {
        assistantIdx = i;
        break;
      }
    }
    if (assistantIdx < 0) break; // nothing safe to remove
    let count = 1;
    while (
      assistantIdx + count < messages.length &&
      messages[assistantIdx + count].role === 'tool'
    ) {
      count++;
    }
    messages.splice(assistantIdx, count);
    removed += count;
  }
  return removed;
}

/**
 * Guarantee the prompt fits. First drop oldest history (trimHistoryToFit). If
 * the input STILL can't host MIN_OUTPUT_TOKENS — e.g. a very long pasted
 * document in the single round-1 user turn, where there is no history to drop —
 * truncate the largest message's content, KEEPING ITS HEAD, until it fits. In
 * the deep-search prompt the question/paste sits at the top and the injected
 * excerpts at the bottom, so keep-head preserves the user's text and sheds the
 * (re-fetchable) excerpts first. Returns messages removed + chars truncated so
 * the caller can surface a "input was shortened" notice.
 */
export function trimMessagesToFit(
  messages: ChatMessage[],
  contextTokens: number = RLM_CONTEXT_TOKENS,
): { removed: number; truncatedChars: number } {
  const removed = trimHistoryToFit(messages, contextTokens);
  let truncatedChars = 0;
  const TRUNC_MARKER = '\n\n…[input truncated to fit the model context window]';
  const fits = () =>
    estimateInputTokens(messages) + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS <= contextTokens;
  while (!fits()) {
    let idx = -1, maxLen = 0;
    for (let i = 0; i < messages.length; i++) {
      const len = messages[i].content?.length ?? 0;
      if (len > maxLen) { maxLen = len; idx = i; }
    }
    if (idx < 0 || maxLen <= TRUNC_MARKER.length) break; // nothing left to shed
    const overTokens =
      estimateInputTokens(messages) + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS - contextTokens;
    const dropChars = Math.ceil(overTokens * TOKEN_CHAR_RATIO) + TRUNC_MARKER.length + 64;
    const cur = messages[idx].content ?? '';
    const keep = Math.max(0, cur.length - dropChars);
    messages[idx] = { ...messages[idx], content: cur.slice(0, keep) + TRUNC_MARKER };
    truncatedChars += cur.length - (messages[idx].content?.length ?? 0);
    if (keep === 0) break; // already minimal — avoid an infinite loop
  }
  return { removed, truncatedChars };
}

/** Minimal shape of what resolveRlmEndpoint needs from a fleet status. */
interface FleetLike {
  sidecars: Array<{ status: string; url: string; hostname?: string; sidecarStatus?: unknown }>;
}

/**
 * Find a sidecar running ss-rlm-sandbox.
 *
 * Shared by both entry paths so they cannot drift:
 *   `primary === true`  — cloud-only. The sandbox IS the configuration; a
 *                         normal INFO, not a degradation.
 *   `primary === false` — local-first. ss-rlm was wanted and is unavailable,
 *                         so the answer is genuinely degraded and says so.
 *
 * The distinction matters operationally: logging DEGRADED for a deliberately
 * chosen configuration trains people to ignore the word, and then it fails to
 * warn on the day something really did degrade.
 */
function resolveSandboxEndpoint(
  fleet: FleetLike,
  sandboxModel: string | undefined,
  primary: boolean,
): ResolvedRlmEndpoint | null {
  if (!sandboxModel) {
    console.warn('[RLM] sandbox skipped — no rlm.sandboxModel configured on /admin/openrouter.');
    return null;
  }
  for (const s of fleet.sidecars) {
    if (s.status !== 'connected') continue;
    const sandboxCS = (s.sidecarStatus as { containers?: Record<string, { status?: string }> } | undefined)
      ?.containers?.['rlm-sandbox'];
    if (!sandboxCS || sandboxCS.status !== 'running') continue;
    try {
      const host = new URL(s.url).hostname;
      const budget = hostedContextBudget(sandboxModel);
      const ctxNote = budget === RLM_CONTEXT_TOKENS
        ? ' — model not in catalogue, using the self-hosted ceiling'
        : '';
      const where = `ss-rlm-sandbox on ${s.hostname ?? s.url} → http://${host}:${RLM_SANDBOX_PORT} (model=${sandboxModel}, ctx=${budget}${ctxNote})`;
      if (primary) {
        console.log(`[RLM] using ${where} — virtualInference.mode.rlm=cloud-only`);
      } else {
        console.warn(`[RLM] DEGRADED: falling back to ${where} — ss-rlm is unavailable`);
      }
      return { endpoint: `http://${host}:${RLM_SANDBOX_PORT}`, host, sandbox: true, model: sandboxModel, contextTokens: budget };
    } catch { /* skip */ }
  }
  console.warn(`[RLM] no sidecar has rlm-sandbox running${primary ? ' (mode=cloud-only, so there is no ss-rlm to fall back to)' : ' either'}.`);
  return null;
}

export async function resolveRlmEndpoint(): Promise<ResolvedRlmEndpoint | null> {
  try {
    const { getFleetStatus } = await import('@/lib/gpu/fleet-router');
    const fleet = await getFleetStatus();

    // ── Phase 0: cloud-only short-circuit ────────────────────────────────
    // The operator has declared the sandbox to be the RLM. Probing for an
    // ss-rlm that is deliberately not deployed costs a fleet round-trip on
    // every call and then logs DEGRADED for what is actually the chosen
    // configuration. Skip straight to the sandbox.
    //
    // Deliberately AFTER getFleetStatus() — the sandbox lives on a sidecar
    // too, so we need the fleet either way; only the ss-rlm discovery below
    // is skipped.
    try {
      const { getConfig } = await import('@/lib/db/config');
      const cfg = await getConfig();
      if (cfg.virtualInferenceModeRlm === 'cloud-only') {
        return resolveSandboxEndpoint(fleet, cfg.rlmSandboxModel, true);
      }
    } catch (err) {
      // A config read failure must not disable RLM — fall through to the
      // normal discovery path, which is what an unconfigured install does.
      console.warn(`[RLM] mode check failed, continuing with local discovery: ${(err as Error).message}`);
    }

    const probed: string[] = [];
    // Track candidates whose cached rlm status is transitional ('not_found',
    // 'created', 'starting') so we can re-probe their live /api/status if
    // the cache is between heartbeats after a container restart.
    const transitional: Array<{ url: string; hostname: string }> = [];

    for (const s of fleet.sidecars) {
      if (s.status !== 'connected') { probed.push(`${s.hostname ?? s.url}:skip-not-connected`); continue; }
      const rlmCS = (s.sidecarStatus as { containers?: Record<string, { status?: string; image?: string }> } | undefined)?.containers?.rlm;
      if (!rlmCS) {
        // Sidecar might be alive but cache hasn't recorded the rlm container
        // yet (heartbeat lag after assigning the role). Still worth probing.
        transitional.push({ url: s.url, hostname: s.hostname ?? s.url });
        probed.push(`${s.hostname ?? s.url}:skip-no-rlm`);
        continue;
      }
      if (rlmCS.status !== 'running') {
        // Transitional state — container being created, restarted, or just
        // removed. Add to live-probe list in case the cache is stale.
        if (rlmCS.status === 'not_found' || rlmCS.status === 'created' || rlmCS.status === 'starting' || rlmCS.status === 'restarting') {
          transitional.push({ url: s.url, hostname: s.hostname ?? s.url });
        }
        probed.push(`${s.hostname ?? s.url}:skip-rlm-${rlmCS.status}`);
        continue;
      }
      if (rlmCS.image === 'dmr' || rlmCS.image === 'host-ollama' || rlmCS.image === 'docker-model-runner') {
        probed.push(`${s.hostname ?? s.url}:skip-synthetic-${rlmCS.image}`);
        continue;
      }
      try {
        const host = new URL(s.url).hostname;
        console.log(`[RLM] endpoint resolved: ${s.hostname ?? s.url} → http://${host}:${RLM_PORT} (others: ${probed.join(', ') || 'none'})`);
        return { endpoint: `http://${host}:${RLM_PORT}`, host, contextTokens: RLM_CONTEXT_TOKENS };
      } catch { /* skip */ }
    }

    // Cache miss — fall back to direct live probes of transitional sidecars
    // so an in-flight container restart doesn't fail the user's search just
    // because the next heartbeat hasn't arrived yet (typical lag is ~5s).
    if (transitional.length > 0) {
      console.log(`[RLM] cache miss — probing ${transitional.length} transitional sidecar(s) directly: ${transitional.map(t => t.hostname).join(', ')}`);
      for (const cand of transitional) {
        try {
          const r = await fetch(`${cand.url.replace(/\/+$/, '')}/api/status`, { signal: AbortSignal.timeout(3000) });
          if (!r.ok) { probed.push(`${cand.hostname}:live-probe-http-${r.status}`); continue; }
          const live = await r.json() as { containers?: Record<string, { status?: string; image?: string }> };
          const liveRlm = live.containers?.rlm;
          if (!liveRlm) { probed.push(`${cand.hostname}:live-probe-no-rlm`); continue; }
          if (liveRlm.status !== 'running') { probed.push(`${cand.hostname}:live-probe-rlm-${liveRlm.status}`); continue; }
          if (liveRlm.image === 'dmr' || liveRlm.image === 'host-ollama' || liveRlm.image === 'docker-model-runner') {
            probed.push(`${cand.hostname}:live-probe-synthetic-${liveRlm.image}`);
            continue;
          }
          const host = new URL(cand.url).hostname;
          console.log(`[RLM] endpoint resolved via live probe (cache was stale): ${cand.hostname} → http://${host}:${RLM_PORT}`);
          return { endpoint: `http://${host}:${RLM_PORT}`, host, contextTokens: RLM_CONTEXT_TOKENS };
        } catch (err) {
          probed.push(`${cand.hostname}:live-probe-err-${(err as Error).message.slice(0, 40)}`);
        }
      }

      // Last-resort: vLLM is sometimes running on the host with no
      // sidecar-tracked container — observed when an operator deletes &
      // recreates ss-rlm out-of-band, or when vLLM was started bare-metal.
      // The sidecar reports rlm.status='not_found' but :8100/v1/models on
      // the same host answers 200 OK. Trust that signal directly.
      console.log(`[RLM] live-probe still empty — last-resort: probing :${RLM_PORT}/v1/models on each transitional host`);
      for (const cand of transitional) {
        try {
          const host = new URL(cand.url).hostname;
          const probeUrl = `http://${host}:${RLM_PORT}/v1/models`;
          const r = await fetch(probeUrl, { signal: AbortSignal.timeout(2500) });
          if (!r.ok) { probed.push(`${cand.hostname}:vllm-probe-http-${r.status}`); continue; }
          // Sanity check: response must look like an OpenAI /v1/models payload
          // mentioning the RLM model id, so we don't latch onto an unrelated
          // service that happens to answer on port 8100.
          const body = await r.text().catch(() => '');
          if (!body.includes(RLM_MODEL_ID)) {
            probed.push(`${cand.hostname}:vllm-probe-wrong-model`);
            continue;
          }
          console.warn(`[RLM] endpoint resolved via vLLM direct probe — sidecar says rlm not_found but vLLM is serving (operator deleted/recreated container out-of-band?). host=${host}`);
          return { endpoint: `http://${host}:${RLM_PORT}`, host, contextTokens: RLM_CONTEXT_TOKENS };
        } catch (err) {
          probed.push(`${cand.hostname}:vllm-probe-err-${(err as Error).message.slice(0, 40)}`);
        }
      }
    }

    console.warn(`[RLM] endpoint NOT resolved — no sidecar has rlm=running. Fleet check: ${probed.join(', ') || '(empty fleet)'}`);

    // ── Phase 2: ss-rlm-sandbox fallback ──────────────────────────────────
    // Every ss-rlm discovery path above (cache, live-probe, direct vLLM
    // probe) came up empty. Fall back to a sidecar running ss-rlm-sandbox —
    // the RLM *pattern* driven against a hosted OpenRouter chat model
    // instead of the self-hosted fine-tune — but ONLY when the operator has
    // opted in via virtualInference.mode.rlm. Default is 'local-only': an
    // unconfigured install throws exactly as it did before this fallback
    // existed, rather than silently degrading a deep-research answer to a
    // different model with no visible signal (see fleet-router.ts's Phase 4
    // for the analogous local-only-by-default pattern on other roles).
    try {
      const { getConfig } = await import('@/lib/db/config');
      const cfg = await getConfig();
      if (cfg.virtualInferenceModeRlm === 'local-only') {
        console.warn('[RLM] sandbox fallback skipped — virtualInference.mode.rlm=local-only (default). Set it on /admin/openrouter to allow.');
        return null;
      }
      return resolveSandboxEndpoint(fleet, cfg.rlmSandboxModel, false);
    } catch (err) {
      console.warn(`[RLM] sandbox fallback check failed: ${(err as Error).message}`);
    }
  } catch (err) {
    console.warn(`[RLM] endpoint resolve failed: fleet-router error: ${(err as Error).message}`);
  }
  return null;
}

export async function* streamRlm(opts: {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): AsyncGenerator<StreamRlmEvent> {
  const resolved = await resolveRlmEndpoint();
  if (!resolved) {
    yield {
      type: 'error',
      message: 'No sidecar with ss-rlm running. Check /admin/gpu — assign ss-rlm to a Linux/Windows+NVIDIA sidecar and start the container.',
    };
    return;
  }
  const endpoint = resolved.endpoint;

  // sandbox: the "model" is the operator-configured OpenRouter chat-model id
  // (rlm.sandboxModel), not the self-hosted RLM fine-tune.
  const model = resolved.sandbox && resolved.model ? resolved.model : RLM_MODEL_ID;
  // Same context-budget defense as runRlmWithTools — streamRlm is the
  // tool-less path (synthesis / draft generation). Clamp without trimming
  // since this path has only system+user. The budget comes from the resolved
  // endpoint, so the hosted sandbox model is not held to ss-rlm's ceiling.
  const ctxBudget = resolved.contextTokens;
  const clamp = clampOutputTokens(opts.messages, opts.maxTokens ?? 2048, ctxBudget);
  if (clamp.clamped) {
    console.warn(`[RLM] streamRlm clamp max_tokens ${opts.maxTokens ?? 2048} → ${clamp.maxTokens} (estimatedInput=${clamp.estimatedInput}, ctx=${ctxBudget})`);
  }
  let res: Response;
  try {
    res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: await rlmHeaders(resolved),
      body: JSON.stringify({
        model,
        messages: opts.messages,
        max_tokens: clamp.maxTokens,
        temperature: opts.temperature ?? 0.3,
        stream: true,
      }),
      signal: opts.signal,
    });
  } catch (err) {
    yield { type: 'error', message: `RLM endpoint ${endpoint} unreachable: ${(err as Error).message}` };
    return;
  }

  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => '');
    yield { type: 'error', message: `RLM HTTP ${res.status}: ${errBody.slice(0, 300)}` };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            full += delta;
            yield { type: 'token', text: delta };
          }
          if (j.usage) {
            inputTokens = j.usage.prompt_tokens ?? inputTokens;
            outputTokens = j.usage.completion_tokens ?? outputTokens;
          }
        } catch { /* malformed SSE chunk — skip */ }
      }
    }
  } catch (err) {
    yield { type: 'error', message: `RLM stream error: ${(err as Error).message}` };
    return;
  }

  yield {
    type: 'done',
    content: full,
    usage: { inputTokens, outputTokens },
    provider: 'rlm',
    model,
  };
}

// ---------------------------------------------------------------------------
// Phase B — tool-use loop ("recursive" RLM via vLLM OpenAI tool calling)
// ---------------------------------------------------------------------------

export interface RlmToolCallEvent {
  type: 'tool-call';
  round: number;
  toolName: string;
  args: Record<string, unknown>;
}

export interface RlmToolResultEvent {
  type: 'tool-result';
  round: number;
  toolName: string;
  ok: boolean;
  preview?: string;
  chunkCount?: number;
}

export interface RlmTokenEvent { type: 'token'; text: string }
export interface RlmDoneEvent {
  type: 'done';
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  rounds: number;
  host: string;
  model: string;
}
export interface RlmStartEvent { type: 'start'; host: string; model: string }
export interface RlmErrorEvent { type: 'error'; message: string }
/** Non-fatal signal that the prompt had to be shortened to fit the context. */
export interface RlmNoticeEvent { type: 'notice'; message: string }

export type RlmRunEvent =
  | RlmStartEvent
  | RlmTokenEvent
  | RlmToolCallEvent
  | RlmToolResultEvent
  | RlmDoneEvent
  | RlmErrorEvent
  | RlmNoticeEvent;

export type ToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; content: string; preview?: string; chunkCount?: number }>;

/**
 * Drive the RLM through an OpenAI tool-calling loop. Each round we POST
 * the running message list to /v1/chat/completions (non-stream). If the
 * model responds with tool_calls, we execute them via `executeTool`,
 * append `tool` messages, and loop. When the model responds without
 * tool_calls we stream that final turn and finish.
 *
 * `maxRounds` caps recursion to keep cost bounded.
 */
export async function* runRlmWithTools(opts: {
  messages: ChatMessage[];
  tools: RlmToolSpec[];
  executeTool: ToolExecutor;
  maxRounds?: number;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): AsyncGenerator<RlmRunEvent> {
  const resolved = await resolveRlmEndpoint();
  if (!resolved) {
    yield {
      type: 'error',
      message: 'No sidecar with ss-rlm running. Assign ss-rlm in /admin/gpu and start the vLLM container.',
    };
    return;
  }
  const { endpoint, host } = resolved;
  // sandbox: drive the configured hosted chat model instead of the
  // self-hosted RLM fine-tune. See resolveRlmEndpoint()'s Phase 2.
  const model = resolved.sandbox && resolved.model ? resolved.model : RLM_MODEL_ID;
  // Budget every round against THIS endpoint's window, not ss-rlm's fixed
  // ceiling. The tool loop is where it matters most: it accumulates chunk
  // payloads across rounds, and on a hosted model that ceiling was throwing
  // away context the provider would happily have taken.
  const ctxBudget = resolved.contextTokens;
  const maxRounds = opts.maxRounds ?? 4;
  const t0 = Date.now();

  // Initial prompt size — operator wants to know "is the request actually big".
  const initialPromptChars = opts.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  console.log(`[RLM] run start endpoint=${endpoint} model=${model} sandbox=${!!resolved.sandbox} ctx=${ctxBudget} maxRounds=${maxRounds} tools=[${opts.tools.map(t => t.function.name).join(', ')}] initialPromptChars=${initialPromptChars} maxTokens=${opts.maxTokens ?? 2048}`);

  // Visible signal that this run used the degraded hosted-pattern fallback,
  // not the self-hosted RLM — surfaced to the caller (deep-search.ts) rather
  // than silently answering with a different model. See design constraint:
  // "do not silently degrade a deep-search answer without it being visible."
  if (resolved.sandbox) {
    yield { type: 'notice', message: `ss-rlm unavailable — using ss-rlm-sandbox (${model}) instead of the self-hosted RLM.` };
  }

  yield { type: 'start', host, model };

  const messages: ChatMessage[] = [...opts.messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const requestedMaxTokens = opts.maxTokens ?? 2048;

  for (let round = 1; round <= maxRounds; round++) {
    const roundT0 = Date.now();
    const promptChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);

    // ── Context budget enforcement ────────────────────────────────────────
    // vLLM rejects prompt_tokens + max_tokens > max_model_len. Clamp first;
    // if even MIN_OUTPUT_TOKENS doesn't fit, trim oldest history and re-clamp.
    let clamp = clampOutputTokens(messages, requestedMaxTokens, ctxBudget);
    if (clamp.needsInputTrim) {
      // Input alone is too large to leave room for a useful answer. Drop oldest
      // history and, if still over (e.g. a giant round-1 paste with no history),
      // truncate the largest message keeping its head. This GUARANTEES we never
      // send prompt_tokens + max_tokens > max_model_len (the prior 400).
      const before = messages.length;
      const { removed, truncatedChars } = trimMessagesToFit(messages, ctxBudget);
      clamp = clampOutputTokens(messages, requestedMaxTokens, ctxBudget);
      console.warn(`[RLM] round ${round} input over budget — removed ${removed} msg(s) (was=${before}, now=${messages.length})${truncatedChars > 0 ? `, truncated ${truncatedChars} chars` : ''}; estInput now ${clamp.estimatedInput}, maxTokens ${clamp.maxTokens}`);
      if (truncatedChars > 0) {
        yield {
          type: 'notice',
          message: `Your input was too long for the model's ${ctxBudget}-token window — about ${Math.round(truncatedChars / TOKEN_CHAR_RATIO)} tokens of input were dropped to make room for the answer. Shorten the pasted text or split it across turns for a complete result.`,
        };
      }
    } else if (clamp.clamped) {
      console.warn(`[RLM] round ${round} clamp max_tokens ${requestedMaxTokens} → ${clamp.maxTokens} (estimatedInput=${clamp.estimatedInput}, ctx=${ctxBudget})`);
    }
    const roundMaxTokens = clamp.maxTokens;

    console.log(`[RLM] round ${round}/${maxRounds} POST ${endpoint}/v1/chat/completions promptChars=${promptChars} messages=${messages.length} maxTokens=${roundMaxTokens} estInput=${clamp.estimatedInput}`);
    let res: Response;
    try {
      res = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: await rlmHeaders(resolved),
        body: JSON.stringify({
          model,
          messages,
          tools: opts.tools,
          // Last round: forbid further tool calls so the model MUST emit a final
          // text answer instead of gathering forever. The RLM (an evidence-
          // gatherer) otherwise issues a fresh tool call every round and never
          // self-terminates — it would hit maxRounds and bail with no answer,
          // discarding all the evidence gathered. `tool_choice:'none'` forces a
          // clean termination on the final round.
          tool_choice: round === maxRounds ? 'none' : 'auto',
          max_tokens: roundMaxTokens,
          temperature: opts.temperature ?? 0.3,
          stream: false,
        }),
        signal: opts.signal,
      });
    } catch (err) {
      console.error(`[RLM] round ${round} fetch failed (elapsed=${Date.now() - roundT0}ms): ${(err as Error).message}`);
      yield { type: 'error', message: `RLM endpoint ${endpoint} unreachable: ${(err as Error).message}` };
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[RLM] round ${round} HTTP ${res.status} (elapsed=${Date.now() - roundT0}ms): ${body.slice(0, 500)}`);
      yield { type: 'error', message: `RLM HTTP ${res.status} (round ${round}): ${body.slice(0, 300)}` };
      return;
    }

    let j: any;
    try { j = await res.json(); } catch (err) {
      console.error(`[RLM] round ${round} JSON parse failed (elapsed=${Date.now() - roundT0}ms): ${(err as Error).message}`);
      yield { type: 'error', message: `RLM JSON parse error (round ${round}): ${(err as Error).message}` };
      return;
    }

    if (j.usage) {
      totalInputTokens += j.usage.prompt_tokens ?? 0;
      totalOutputTokens += j.usage.completion_tokens ?? 0;
    }
    const roundElapsed = Date.now() - roundT0;
    const rawToolCallCount = Array.isArray(j.choices?.[0]?.message?.tool_calls) ? j.choices[0].message.tool_calls.length : 0;
    const contentLen = typeof j.choices?.[0]?.message?.content === 'string' ? j.choices[0].message.content.length : 0;
    console.log(`[RLM] round ${round} response elapsed=${roundElapsed}ms vllm_tool_calls=${rawToolCallCount} content_chars=${contentLen} usage=${JSON.stringify(j.usage ?? null)}`);

    const choice = j.choices?.[0];
    const msg = choice?.message;
    // On the final round we sent tool_choice:'none', so never interpret the
    // response as a tool call (even tool-call-shaped text) — whatever the model
    // produced is the final answer, which ends the loop cleanly.
    let toolCalls: ToolCall[] | undefined = round === maxRounds ? undefined : msg?.tool_calls;

    // Defensive fallback: when vLLM's tool-call parser misses the shape the
    // model emitted, scan the assistant content for known tool-call forms
    // (pythonic positional/kwargs, hermes <tool_call>, bare JSON line) for
    // any of the tools the caller declared. See docs/search-unification — RLM
    // was emitting `query_case_knowledge("...")` plain-text under hermes
    // parser config and the loop terminated early.
    if (round !== maxRounds && (!toolCalls || toolCalls.length === 0) && typeof msg?.content === 'string' && msg.content.length > 0) {
      const fallback = extractFallbackToolCalls(msg.content, opts.tools, round);
      if (fallback.length > 0) {
        console.warn(
          `[RLM] round ${round} fallback parser fired: vLLM tool_calls empty but content matched ${fallback.length} call(s) for [${fallback.map(c => c.function.name).join(', ')}]. Parser config likely mismatched. Content preview: ${msg.content.slice(0, 200).replace(/\s+/g, ' ')}`,
        );
        toolCalls = fallback;
      } else {
        console.log(`[RLM] round ${round} no tool_calls and fallback parser found none in content (${msg.content.length} chars). Treating as final answer. Preview: ${msg.content.slice(0, 200).replace(/\s+/g, ' ')}`);
      }
    }

    if (toolCalls && toolCalls.length > 0) {
      console.log(`[RLM] round ${round} executing ${toolCalls.length} tool call(s): [${toolCalls.map(c => c.function.name).join(', ')}]`);
      // Append assistant message with tool_calls (content may be null/empty)
      messages.push({
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : '',
        tool_calls: toolCalls,
      });

      // Execute each tool call sequentially (avoids hammering the RAG layer
      // and keeps the progress feed coherent).
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {};
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; }
        catch { args = {}; }
        const callT0 = Date.now();
        const argsPreview = JSON.stringify(args).slice(0, 200);
        console.log(`[RLM] round ${round} → tool ${call.function.name}(${argsPreview})`);
        yield { type: 'tool-call', round, toolName: call.function.name, args };
        const result = await opts.executeTool(call.function.name, args);
        const callMs = Date.now() - callT0;
        console.log(`[RLM] round ${round} ← tool ${call.function.name} ok=${result.ok} chunks=${result.chunkCount ?? 0} elapsed=${callMs}ms preview="${(result.preview ?? '').slice(0, 80)}"`);
        yield {
          type: 'tool-result',
          round,
          toolName: call.function.name,
          ok: result.ok,
          preview: result.preview,
          chunkCount: result.chunkCount,
        };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: result.content,
        });
      }
      continue;
    }

    // No tool calls — this is the final answer. Re-issue as a streaming
    // request so the user sees tokens flow instead of waiting for the
    // round-trip we just did. We could return msg.content directly, but
    // streaming gives the UI a live feed and matches the other paths.
    //
    // Same clamp logic as the round POST — the streaming retry hits the same
    // vLLM ceiling and would otherwise re-trigger the 400 we just dodged.
    const streamClamp = clampOutputTokens(messages, requestedMaxTokens);
    if (streamClamp.clamped) {
      console.warn(`[RLM] round ${round} stream-retry clamp max_tokens → ${streamClamp.maxTokens} (estimatedInput=${streamClamp.estimatedInput})`);
    }
    console.log(`[RLM] round ${round} no tool calls — streaming final answer (re-POST with stream=true, maxTokens=${streamClamp.maxTokens})`);
    let stream: Response;
    try {
      stream = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: await rlmHeaders(resolved),
        body: JSON.stringify({
          model,
          messages,
          max_tokens: streamClamp.maxTokens,
          temperature: opts.temperature ?? 0.3,
          stream: true,
        }),
        signal: opts.signal,
      });
    } catch (err) {
      // Fallback: emit the non-stream content we already have.
      const content = typeof msg?.content === 'string' ? msg.content : '';
      if (content) yield { type: 'token', text: content };
      yield {
        type: 'done',
        content,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        rounds: round,
        host,
        model,
      };
      return;
    }

    if (!stream.ok || !stream.body) {
      const body = await stream.text().catch(() => '');
      yield { type: 'error', message: `RLM final stream HTTP ${stream.status}: ${body.slice(0, 300)}` };
      return;
    }

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            const delta = evt.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              full += delta;
              yield { type: 'token', text: delta };
            }
            if (evt.usage) {
              totalInputTokens = evt.usage.prompt_tokens ?? totalInputTokens;
              totalOutputTokens = evt.usage.completion_tokens ?? totalOutputTokens;
            }
          } catch { /* malformed SSE — skip */ }
        }
      }
    } catch (err) {
      yield { type: 'error', message: `RLM final stream error: ${(err as Error).message}` };
      return;
    }

    console.log(`[RLM] run done rounds=${round} totalElapsed=${Date.now() - t0}ms finalContentChars=${full.length} tokens=${totalInputTokens}in+${totalOutputTokens}out`);
    yield {
      type: 'done',
      content: full,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      rounds: round,
      host,
      model,
    };
    return;
  }

  console.warn(`[RLM] tool-use loop hit maxRounds=${maxRounds} without final answer — bailing`);
  yield { type: 'error', message: `RLM tool-use loop exceeded maxRounds=${maxRounds}` };
}

// ---------------------------------------------------------------------------
// Fallback tool-call parser
// ---------------------------------------------------------------------------

/**
 * Scan free-text assistant content for tool calls the vLLM parser missed.
 * Detects four shapes per tool name:
 *   - pythonic positional:  name("...")
 *   - pythonic kwargs:      name(query="...", limit=20)
 *   - hermes XML:           <tool_call>{"name":"...","arguments":{...}}</tool_call>
 *   - bare JSON line:       {"name":"...","arguments":{...}}
 */
export function extractFallbackToolCalls(
  content: string,
  tools: RlmToolSpec[],
  round: number,
): ToolCall[] {
  const out: ToolCall[] = [];

  // Shape 0 — Qwen XML format. The mit-oasys RLM Qwen3-8B fine-tune emits:
  //
  //   <tool_call>
  //   <function=NAME>
  //   <parameter=KEY>VALUE</parameter>
  //   ...
  //   </function>
  //   </tool_call>
  //
  // Neither vLLM's `hermes` (expects JSON-inside-<tool_call>) nor `pythonic`
  // (expects `name(args)`) parses this. Confirmed empirically via
  // scripts/test-rlm.ts on 2026-05-26 — model's first round emits exactly
  // this XML shape and vLLM returns `tool_calls: []`. We catch it ourselves.
  const qwenXmlRe = /<tool_call>\s*<function\s*=\s*([A-Za-z_][\w-]*)\s*>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
  const paramRe = /<parameter\s*=\s*([A-Za-z_][\w-]*)\s*>([\s\S]*?)<\/parameter>/g;
  let qm: RegExpExecArray | null;
  while ((qm = qwenXmlRe.exec(content)) !== null) {
    const fnName = qm[1];
    if (!tools.some(t => t.function.name === fnName)) continue;
    const body = qm[2];
    const args: Record<string, unknown> = {};
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(body)) !== null) {
      const key = pm[1];
      const raw = pm[2].trim();
      // Coerce simple JSON-like primitives so the master's stub/tool gets
      // typed args (e.g. limit:10 as a number, not "10").
      if (/^-?\d+(?:\.\d+)?$/.test(raw)) args[key] = Number(raw);
      else if (raw === 'true') args[key] = true;
      else if (raw === 'false') args[key] = false;
      else if (raw === 'null') args[key] = null;
      else args[key] = raw;
    }
    out.push({
      id: `fallback-${round}-${out.length}`,
      type: 'function',
      function: { name: fnName, arguments: JSON.stringify(args) },
    });
  }

  // Shape 3 — hermes <tool_call>{...}</tool_call> (any tool name)
  const hermesRe = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = hermesRe.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj.name === 'string' && tools.some(t => t.function.name === obj.name)) {
        const args = obj.arguments ?? obj.parameters ?? {};
        out.push({
          id: `fallback-${round}-${out.length}`,
          type: 'function',
          function: { name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
        });
      }
    } catch { /* skip malformed */ }
  }

  // Shape 4 — bare JSON line (only well-formed single-line objects)
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.name === 'string' && tools.some(t => t.function.name === obj.name)) {
        const args = obj.arguments ?? obj.parameters ?? {};
        // Skip if we already captured this exact call via hermes.
        const argStr = typeof args === 'string' ? args : JSON.stringify(args);
        if (out.some(c => c.function.name === obj.name && c.function.arguments === argStr)) continue;
        out.push({
          id: `fallback-${round}-${out.length}`,
          type: 'function',
          function: { name: obj.name, arguments: argStr },
        });
      }
    } catch { /* skip */ }
  }

  // Shapes 1 & 2 — pythonic per-tool
  for (const tool of tools) {
    const name = tool.function.name;
    // Escape regex meta in tool name (defensive — tool names are usually plain).
    const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Pythonic positional: name("...") or name('...')  — capture first string arg
    const posRe = new RegExp(`\\b${safeName}\\s*\\(\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1\\s*\\)`, 'g');
    let pm: RegExpExecArray | null;
    while ((pm = posRe.exec(content)) !== null) {
      const queryArg = pm[2].replace(/\\(["'\\])/g, '$1');
      const argStr = JSON.stringify({ query: queryArg });
      if (out.some(c => c.function.name === name && c.function.arguments === argStr)) continue;
      out.push({
        id: `fallback-${round}-${out.length}`,
        type: 'function',
        function: { name, arguments: argStr },
      });
    }

    // Pythonic kwargs: name(key="val", key2=123, key3='x')
    const kwRe = new RegExp(`\\b${safeName}\\s*\\(\\s*([a-zA-Z_][a-zA-Z0-9_]*\\s*=[^)]*)\\)`, 'g');
    let km: RegExpExecArray | null;
    while ((km = kwRe.exec(content)) !== null) {
      const kwBody = km[1];
      const args: Record<string, unknown> = {};
      // Match key=value pairs: value is "..." | '...' | number | bareword
      const pairRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:(["'])((?:\\.|(?!\2).)*)\2|(-?\d+(?:\.\d+)?)|([a-zA-Z_][a-zA-Z0-9_]*))/g;
      let pm2: RegExpExecArray | null;
      while ((pm2 = pairRe.exec(kwBody)) !== null) {
        const k = pm2[1];
        if (pm2[2] !== undefined) {
          args[k] = pm2[3].replace(/\\(["'\\])/g, '$1');
        } else if (pm2[4] !== undefined) {
          args[k] = Number(pm2[4]);
        } else if (pm2[5] !== undefined) {
          const v = pm2[5];
          args[k] = v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : v;
        }
      }
      if (Object.keys(args).length === 0) continue;
      const argStr = JSON.stringify(args);
      if (out.some(c => c.function.name === name && c.function.arguments === argStr)) continue;
      out.push({
        id: `fallback-${round}-${out.length}`,
        type: 'function',
        function: { name, arguments: argStr },
      });
    }
  }

  return out;
}
