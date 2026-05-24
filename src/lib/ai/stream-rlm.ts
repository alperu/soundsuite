/**
 * Stream from ss-rlm (Recursive Language Model) — Qwen3-8B post-trained — by
 * hitting the vLLM container's OpenAI-compatible /v1/chat/completions on a
 * sidecar that has `containers.rlm.status === 'running'`. Yields the same
 * event shape as `streamAI()` (`{ type: 'token', text }` / `{ type: 'done',
 * usage, content, provider, model }`) so the API route can swap providers
 * without touching the consumer code.
 *
 * Discovery mirrors src/lib/search/reranker.ts: pick a connected sidecar
 * whose cached status reports rlm running on a real vLLM image (not a
 * synthetic 'dmr' / 'host-ollama' image).
 *
 * NOTE: This is the v1 "explicit toggle" path — Phase A of the RLM rollout.
 * Phase B (deep-search with the Pyodide RLM runtime that does recursive
 * sub-calls) builds on top of this same endpoint discovery.
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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

async function resolveRlmEndpoint(): Promise<string | null> {
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
        return `http://${host}:${RLM_PORT}`;
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
  const endpoint = await resolveRlmEndpoint();
  if (!endpoint) {
    yield {
      type: 'error',
      message: 'No sidecar with ss-rlm running. Check /admin/gpu — assign ss-rlm to a Linux/Windows+NVIDIA sidecar and start the container.',
    };
    return;
  }

  const model = 'mit-oasys/rlm-qwen3-8b-v0.1';
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
