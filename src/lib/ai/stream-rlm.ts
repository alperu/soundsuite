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

interface ChatMessage {
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

export async function resolveRlmEndpoint(): Promise<ResolvedRlmEndpoint | null> {
  try {
    const { getFleetStatus } = await import('@/lib/gpu/fleet-router');
    const fleet = await getFleetStatus();
    for (const s of fleet.sidecars) {
      if (s.status !== 'connected') continue;
      const rlmCS = (s.sidecarStatus as { containers?: Record<string, { status?: string; image?: string }> } | undefined)?.containers?.rlm;
      if (!rlmCS) continue;
      if (rlmCS.status !== 'running') continue;
      if (rlmCS.image === 'dmr' || rlmCS.image === 'host-ollama' || rlmCS.image === 'docker-model-runner') continue;
      try {
        const host = new URL(s.url).hostname;
        return { endpoint: `http://${host}:${RLM_PORT}`, host };
      } catch { /* skip */ }
    }
  } catch { /* fleet-router unavailable */ }
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
  let res: Response;
  try {
    res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 2048,
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

  yield { type: 'start', host, model };

  const messages: ChatMessage[] = [...opts.messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let round = 1; round <= maxRounds; round++) {
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
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.3,
          stream: false,
        }),
        signal: opts.signal,
      });
    } catch (err) {
      yield { type: 'error', message: `RLM endpoint ${endpoint} unreachable: ${(err as Error).message}` };
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      yield { type: 'error', message: `RLM HTTP ${res.status} (round ${round}): ${body.slice(0, 300)}` };
      return;
    }

    let j: any;
    try { j = await res.json(); } catch (err) {
      yield { type: 'error', message: `RLM JSON parse error (round ${round}): ${(err as Error).message}` };
      return;
    }

    if (j.usage) {
      totalInputTokens += j.usage.prompt_tokens ?? 0;
      totalOutputTokens += j.usage.completion_tokens ?? 0;
    }

    const choice = j.choices?.[0];
    const msg = choice?.message;
    const toolCalls: ToolCall[] | undefined = msg?.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
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
        yield { type: 'tool-call', round, toolName: call.function.name, args };
        const result = await opts.executeTool(call.function.name, args);
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
    let stream: Response;
    try {
      stream = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: opts.maxTokens ?? 2048,
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

  yield { type: 'error', message: `RLM tool-use loop exceeded maxRounds=${maxRounds}` };
}
