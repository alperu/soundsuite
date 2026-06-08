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
export const RLM_MODEL_ID = 'mit-oasys/rlm-qwen3-8b-v0.1';

// ──────────────────────────────────────────────────────────────────────────
// Context budgeting — vLLM rejects requests where prompt_tokens +
// max_tokens > max_model_len. The current RLM (Qwen3-8B) is served with
// --max-model-len 65536 (raised from 32768; fp8 KV cache keeps VRAM flat —
// see sideCar mode-templates.ts / state.ts). The tool-use loop accumulates 80+ chunk-sized
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
export const RLM_CONTEXT_TOKENS = 65536;
export const TOKEN_CHAR_RATIO = 3.2;
export const SAFETY_MARGIN_TOKENS = 256;
export const MIN_OUTPUT_TOKENS = 768;

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
): { maxTokens: number; clamped: boolean; estimatedInput: number } {
  const estimatedInput = estimateInputTokens(messages);
  const budget = RLM_CONTEXT_TOKENS - estimatedInput - SAFETY_MARGIN_TOKENS;
  if (budget < MIN_OUTPUT_TOKENS) {
    return { maxTokens: MIN_OUTPUT_TOKENS, clamped: true, estimatedInput };
  }
  if (budget < requested) {
    return { maxTokens: budget, clamped: true, estimatedInput };
  }
  return { maxTokens: requested, clamped: false, estimatedInput };
}

/**
 * When estimatedInput + MIN_OUTPUT_TOKENS doesn't fit even after clamping,
 * trim the oldest assistant message and its trailing tool messages.
 * Preserves messages[0] (system) and messages[1] (the initial user turn).
 * Returns the number of messages removed.
 */
export function trimHistoryToFit(messages: ChatMessage[]): number {
  let removed = 0;
  while (true) {
    const estimatedInput = estimateInputTokens(messages);
    if (estimatedInput + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS <= RLM_CONTEXT_TOKENS) break;
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

export async function resolveRlmEndpoint(): Promise<ResolvedRlmEndpoint | null> {
  try {
    const { getFleetStatus } = await import('@/lib/gpu/fleet-router');
    const fleet = await getFleetStatus();
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
        return { endpoint: `http://${host}:${RLM_PORT}`, host };
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
          return { endpoint: `http://${host}:${RLM_PORT}`, host };
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
          return { endpoint: `http://${host}:${RLM_PORT}`, host };
        } catch (err) {
          probed.push(`${cand.hostname}:vllm-probe-err-${(err as Error).message.slice(0, 40)}`);
        }
      }
    }

    console.warn(`[RLM] endpoint NOT resolved — no sidecar has rlm=running. Fleet check: ${probed.join(', ') || '(empty fleet)'}`);
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

  const model = RLM_MODEL_ID;
  // Same context-budget defense as runRlmWithTools — streamRlm is the
  // tool-less path (synthesis / draft generation) but still hits the same
  // 32K ceiling. Clamp without trimming since this path has only system+user.
  const clamp = clampOutputTokens(opts.messages, opts.maxTokens ?? 2048);
  if (clamp.clamped) {
    console.warn(`[RLM] streamRlm clamp max_tokens ${opts.maxTokens ?? 2048} → ${clamp.maxTokens} (estimatedInput=${clamp.estimatedInput}, ctx=${RLM_CONTEXT_TOKENS})`);
  }
  let res: Response;
  try {
    res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

export type RlmRunEvent =
  | RlmStartEvent
  | RlmTokenEvent
  | RlmToolCallEvent
  | RlmToolResultEvent
  | RlmDoneEvent
  | RlmErrorEvent;

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
  const model = RLM_MODEL_ID;
  const maxRounds = opts.maxRounds ?? 4;
  const t0 = Date.now();

  // Initial prompt size — operator wants to know "is the request actually big".
  const initialPromptChars = opts.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  console.log(`[RLM] run start endpoint=${endpoint} model=${model} maxRounds=${maxRounds} tools=[${opts.tools.map(t => t.function.name).join(', ')}] initialPromptChars=${initialPromptChars} maxTokens=${opts.maxTokens ?? 2048}`);

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
    let clamp = clampOutputTokens(messages, requestedMaxTokens);
    if (clamp.clamped) {
      console.warn(`[RLM] round ${round} clamp max_tokens ${requestedMaxTokens} → ${clamp.maxTokens} (estimatedInput=${clamp.estimatedInput}, ctx=${RLM_CONTEXT_TOKENS})`);
    }
    if (
      clamp.estimatedInput + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS >
      RLM_CONTEXT_TOKENS
    ) {
      const before = messages.length;
      const removed = trimHistoryToFit(messages);
      if (removed > 0) {
        console.warn(`[RLM] round ${round} trim ${removed} oldest message(s) (was=${before}, now=${messages.length}) to fit ctx budget`);
        clamp = clampOutputTokens(messages, requestedMaxTokens);
        if (clamp.clamped) {
          console.warn(`[RLM] round ${round} clamp after trim: max_tokens → ${clamp.maxTokens} (estimatedInput=${clamp.estimatedInput})`);
        }
      } else {
        console.error(`[RLM] round ${round} cannot trim further; sending request that may 400 (estimatedInput=${clamp.estimatedInput} + maxTokens=${clamp.maxTokens} = ${clamp.estimatedInput + clamp.maxTokens})`);
      }
    }
    const roundMaxTokens = clamp.maxTokens;

    console.log(`[RLM] round ${round}/${maxRounds} POST ${endpoint}/v1/chat/completions promptChars=${promptChars} messages=${messages.length} maxTokens=${roundMaxTokens} estInput=${clamp.estimatedInput}`);
    let res: Response;
    try {
      res = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools: opts.tools,
          tool_choice: 'auto',
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
    let toolCalls: ToolCall[] | undefined = msg?.tool_calls;

    // Defensive fallback: when vLLM's tool-call parser misses the shape the
    // model emitted, scan the assistant content for known tool-call forms
    // (pythonic positional/kwargs, hermes <tool_call>, bare JSON line) for
    // any of the tools the caller declared. See docs/search-unification — RLM
    // was emitting `query_case_knowledge("...")` plain-text under hermes
    // parser config and the loop terminated early.
    if ((!toolCalls || toolCalls.length === 0) && typeof msg?.content === 'string' && msg.content.length > 0) {
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
        headers: { 'Content-Type': 'application/json' },
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
