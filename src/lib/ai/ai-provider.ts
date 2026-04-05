/**
 * Unified LLM completion function.
 *
 * Uses the OpenAI SDK for OpenAI, Groq, and Grok (they expose OpenAI-compatible APIs).
 * Uses the Anthropic SDK for Anthropic models.
 * Reads API keys from the Config table via getConfig().
 */

import { AIProviderKey, AI_PROVIDERS } from './models';
import { getConfig, AppConfig } from '../db/config';

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AICompletionRequest {
  provider: AIProviderKey;
  model: string;
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
  /** When true, instruct the model to output valid JSON (Ollama format:"json", OpenAI response_format). */
  jsonMode?: boolean;
  /** Control thinking/reasoning mode for models that support it (e.g. Qwen3). Default true. */
  thinking?: boolean;
}

export interface AICompletionResponse {
  content: string;
  model: string;
  provider: AIProviderKey;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

function getApiKey(config: AppConfig, provider: AIProviderKey): string {
  const configKey = AI_PROVIDERS[provider].configKey;
  const key = (config as any)[configKey] as string | undefined;
  if (!key) {
    throw new Error(`No API key configured for ${AI_PROVIDERS[provider].name}. Set it in Admin > AI Keys.`);
  }
  return key;
}

async function completeWithOpenAICompatible(
  apiKey: string,
  baseURL: string,
  model: string,
  messages: AIMessage[],
  maxTokens: number,
  temperature: number,
  provider: AIProviderKey,
  jsonMode?: boolean,
): Promise<AICompletionResponse> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey, baseURL });

  const response = await client.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });

  const choice = response.choices[0];
  return {
    content: choice?.message?.content ?? '',
    model: response.model,
    provider,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

async function completeWithAnthropic(
  apiKey: string,
  model: string,
  messages: AIMessage[],
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean,
): Promise<AICompletionResponse> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });

  // Extract system message — Anthropic uses a separate `system` param
  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  const outgoingMessages: Array<{ role: 'user' | 'assistant'; content: string }> = nonSystem.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // jsonMode: forced tool use (canonical approach for Claude 4+).
  if (jsonMode) {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: outgoingMessages,
      tools: [
        {
          name: 'emit_json_result',
          description:
            'Emit the structured JSON result that matches the schema described in the system prompt. Call this tool exactly once with your output as the tool input.',
          input_schema: { type: 'object' as const },
        },
      ],
      tool_choice: { type: 'tool' as const, name: 'emit_json_result' },
    });

    // Extract the tool_use block and serialize its input to JSON.
    const toolBlock = response.content.find(
      (b: { type: string }) => b.type === 'tool_use'
    ) as { type: 'tool_use'; input: unknown } | undefined;
    const content = toolBlock ? JSON.stringify(toolBlock.input) : '';

    return {
      content,
      model: response.model,
      provider: 'anthropic',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: outgoingMessages,
  });

  const textBlock = response.content.find(b => b.type === 'text');
  return {
    content: textBlock?.text ?? '',
    model: response.model,
    provider: 'anthropic',
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

/**
 * Stream a chat request to Ollama via Node.js http module.
 * Bypasses global fetch's headersTimeout limit by using socket-level timeouts.
 */
async function ollamaStreamChat(
  url: string,
  body: object,
  socketTimeoutMs: number,
): Promise<{ content: string; promptEvalCount: number; evalCount: number; promptEvalDurationMs: number; evalDurationMs: number }> {
  const http = await import('http');
  const https = await import('https');
  const { URL } = await import('url');

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? '443' : '80'),
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: socketTimeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (d: Buffer) => (errBody += d.toString()));
          res.on('end', () => reject(new Error(`Ollama error (${res.statusCode}): ${errBody}`)));
          return;
        }

        let content = '';
        let promptEvalCount = 0;
        let evalCount = 0;
        let promptEvalDurationMs = 0;
        let evalDurationMs = 0;
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.message?.content) content += parsed.message.content;
              if (parsed.done) {
                promptEvalCount = parsed.prompt_eval_count ?? 0;
                evalCount = parsed.eval_count ?? 0;
                promptEvalDurationMs = Math.round((parsed.prompt_eval_duration ?? 0) / 1e6);
                evalDurationMs = Math.round((parsed.eval_duration ?? 0) / 1e6);
              }
            } catch {
              /* skip malformed lines */
            }
          }
        });

        res.on('end', () => resolve({ content, promptEvalCount, evalCount, promptEvalDurationMs, evalDurationMs }));
        res.on('error', reject);
      },
    );

    req.on('timeout', () => {
      req.destroy(
        new Error(`Ollama completion timed out after ${Math.round(socketTimeoutMs / 1000)}s. Try a smaller/faster model.`),
      );
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function completeWithOllama(
  host: string,
  model: string,
  messages: AIMessage[],
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean,
  thinking?: boolean,
): Promise<AICompletionResponse> {
  const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
  console.log(`[OllamaCompletion] Starting chat — model=${model} host=${host} messages=${messages.length} totalChars=${totalChars} maxTokens=${maxTokens}`);
  const t0 = Date.now();

  // Use Node.js http module with streaming to avoid UND_ERR_HEADERS_TIMEOUT.
  // Node.js's global fetch (undici) has a ~60s default headersTimeout that
  // can't be configured without installing undici separately. The http module
  // gives us full control: the socket timeout (5 min) covers the initial
  // model-loading and prompt-processing pause, then resets automatically as
  // streamed tokens arrive.
  const url = `${host.replace(/\/$/, '')}/api/chat`;
  const socketTimeoutMs = 5 * 60 * 1000;

  const result = await ollamaStreamChat(url, {
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: true,
    ...(jsonMode ? { format: 'json' } : {}),
    ...(thinking !== undefined ? { think: thinking } : {}),
    options: { temperature, num_predict: maxTokens, num_ctx: 6144 },
  }, socketTimeoutMs);

  const durationMs = Date.now() - t0;
  const prefillTokS = result.promptEvalDurationMs > 0 ? Math.round(result.promptEvalCount / (result.promptEvalDurationMs / 1000)) : 0;
  const genTokS = result.evalDurationMs > 0 ? Math.round(result.evalCount / (result.evalDurationMs / 1000)) : 0;
  console.log(`[OllamaCompletion] Chat completed — model=${model} totalMs=${durationMs} prefillMs=${result.promptEvalDurationMs} (${result.promptEvalCount}tok, ${prefillTokS}tok/s) genMs=${result.evalDurationMs} (${result.evalCount}tok, ${genTokS}tok/s)`);

  // Strip <think>...</think> blocks (Qwen3 reasoning mode)
  const content = result.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  return {
    content,
    model,
    provider: 'ollama',
    usage: {
      inputTokens: result.promptEvalCount,
      outputTokens: result.evalCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming completion — yields tokens as they arrive
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; content: string; model: string; provider: AIProviderKey; usage: { inputTokens: number; outputTokens: number } };

/**
 * Stream a chat completion from any provider.
 * Yields `{type:'token'}` events as text arrives, then a final `{type:'done'}`.
 * Falls back to `completeAI` for providers where streaming fails.
 */
export async function* streamAI(req: AICompletionRequest): AsyncGenerator<StreamEvent> {
  const config = await getConfig();
  const maxTokens = req.maxTokens ?? 2048;
  const temperature = req.temperature ?? 0.3;

  console.log('[streamAI] request', {
    provider: req.provider,
    model: req.model,
    jsonMode: req.jsonMode === true,
    temperature,
    maxTokens,
    messageCount: req.messages.length,
  });

  try {
    if (req.provider === 'ollama') {
      yield* streamWithOllama(config, req.model, req.messages, maxTokens, temperature, req.jsonMode, req.thinking);
      return;
    }

    if (req.provider === 'anthropic') {
      const apiKey = getApiKey(config, 'anthropic');
      yield* streamWithAnthropic(apiKey, req.model, req.messages, maxTokens, temperature, req.jsonMode);
      return;
    }

    const baseURL = OPENAI_COMPATIBLE_BASE_URLS[req.provider];
    if (baseURL) {
      const apiKey = getApiKey(config, req.provider);
      yield* streamWithOpenAICompatible(apiKey, baseURL, req.model, req.messages, maxTokens, temperature, req.provider, req.jsonMode);
      return;
    }
  } catch (err) {
    console.warn(`[streamAI] Streaming failed for ${req.provider}, falling back to completeAI:`, (err as Error).message);
  }

  // Fallback: non-streaming completion
  const result = await completeAI(req);
  yield { type: 'token', text: result.content };
  yield { type: 'done', content: result.content, model: result.model, provider: result.provider, usage: result.usage };
}

async function* streamWithOllama(
  config: AppConfig,
  model: string,
  messages: AIMessage[],
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean,
  thinking?: boolean,
): AsyncGenerator<StreamEvent> {
  let host = config.ollamaCompletionHost || config.ollamaHost;

  // Fleet router resolution
  let releaseEndpointFn: (() => void) | undefined;
  if (config.completionUseOrchestrator) {
    try {
      const { resolveEndpoint, releaseEndpoint } = await import('@/lib/gpu/fleet-router');
      const ep = await resolveEndpoint('completion');
      host = ep.host;
      releaseEndpointFn = () => releaseEndpoint('completion', ep.sidecarUrl);
    } catch (err) {
      console.warn('[streamWithOllama] Orchestrator failed, using direct host:', (err as Error).message);
    }
  }

  if (!host) throw new Error('No Ollama host configured.');

  const http = await import('http');
  const https = await import('https');
  const { URL } = await import('url');

  const url = `${host.replace(/\/$/, '')}/api/chat`;
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const client = isHttps ? https : http;
  const socketTimeoutMs = 5 * 60 * 1000;

  const body = JSON.stringify({
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: true,
    ...(jsonMode ? { format: 'json' } : {}),
    ...(thinking !== undefined ? { think: thinking } : {}),
    options: { temperature, num_predict: maxTokens, num_ctx: 6144 },
  });

  // Use an async queue to bridge the callback-based http with async generator
  type QueueItem = { type: 'data'; text: string } | { type: 'end'; content: string; promptEvalCount: number; evalCount: number } | { type: 'error'; error: Error };
  const queue: QueueItem[] = [];
  let resolve: (() => void) | null = null;
  const waitForItem = () => new Promise<void>(r => { resolve = r; });
  const push = (item: QueueItem) => { queue.push(item); if (resolve) { resolve(); resolve = null; } };

  const httpReq = client.request(
    {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? '443' : '80'),
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: socketTimeoutMs,
    },
    (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (d: Buffer) => (errBody += d.toString()));
        res.on('end', () => push({ type: 'error', error: new Error(`Ollama error (${res.statusCode}): ${errBody}`) }));
        return;
      }

      let fullContent = '';
      let promptEvalCount = 0;
      let evalCount = 0;
      let insideThink = false;
      let buffer = '';
      let batchBuffer = '';
      let batchTimer: ReturnType<typeof setTimeout> | null = null;

      const flushBatch = () => {
        if (batchBuffer) {
          push({ type: 'data', text: batchBuffer });
          batchBuffer = '';
        }
        batchTimer = null;
      };

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) {
              let token: string = parsed.message.content;
              fullContent += token;

              // Strip <think>...</think> blocks for Qwen3
              if (!insideThink && token.includes('<think>')) {
                const before = token.split('<think>')[0];
                insideThink = true;
                token = before;
              }
              if (insideThink) {
                if (fullContent.includes('</think>')) {
                  insideThink = false;
                  // Everything after </think> in the accumulated content
                  const afterThink = fullContent.split('</think>').pop() ?? '';
                  // Only emit what's new after the closing tag
                  token = afterThink.slice(-token.length).replace(/<\/?think>/g, '');
                  if (!token) continue;
                } else {
                  continue; // Still inside think block, skip
                }
              }

              if (token) {
                batchBuffer += token;
                if (!batchTimer) {
                  batchTimer = setTimeout(flushBatch, 50);
                }
              }
            }
            if (parsed.done) {
              promptEvalCount = parsed.prompt_eval_count ?? 0;
              evalCount = parsed.eval_count ?? 0;
            }
          } catch { /* skip malformed */ }
        }
      });

      res.on('end', () => {
        if (batchTimer) { clearTimeout(batchTimer); flushBatch(); }
        // Strip think blocks from full content
        const cleanContent = fullContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        push({ type: 'end', content: cleanContent, promptEvalCount, evalCount });
      });
      res.on('error', (err: Error) => push({ type: 'error', error: err }));
    },
  );

  httpReq.on('timeout', () => {
    httpReq.destroy(new Error(`Ollama streaming timed out after ${Math.round(socketTimeoutMs / 1000)}s`));
  });
  httpReq.on('error', (err: Error) => push({ type: 'error', error: err }));
  httpReq.write(body);
  httpReq.end();

  // Yield items from the queue
  while (true) {
    if (queue.length === 0) await waitForItem();
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.type === 'data') {
        yield { type: 'token', text: item.text };
      } else if (item.type === 'end') {
        releaseEndpointFn?.();
        yield { type: 'done', content: item.content, model, provider: 'ollama', usage: { inputTokens: item.promptEvalCount, outputTokens: item.evalCount } };
        return;
      } else if (item.type === 'error') {
        releaseEndpointFn?.();
        throw item.error;
      }
    }
  }
}

async function* streamWithOpenAICompatible(
  apiKey: string,
  baseURL: string,
  model: string,
  messages: AIMessage[],
  maxTokens: number,
  temperature: number,
  provider: AIProviderKey,
  jsonMode?: boolean,
): AsyncGenerator<StreamEvent> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey, baseURL });

  if (jsonMode) {
    console.log(`[streamWithOpenAICompatible] jsonMode=true, setting response_format for ${provider}/${model}`);
  }

  const stream = await client.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
    // Force strict JSON output at the API level. OpenAI, Groq, and Grok all
    // honor response_format: { type: 'json_object' } when the prompt also
    // contains the word "JSON" (which getAutoSuggestPrompt does).
    ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });

  let fullContent = '';
  let batchBuffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullContent += delta;
      batchBuffer += delta;
      // Batch: yield every ~50 chars or on sentence boundaries
      if (batchBuffer.length >= 20 || /[.!?\n]$/.test(batchBuffer)) {
        yield { type: 'token', text: batchBuffer };
        batchBuffer = '';
      }
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0;
      outputTokens = chunk.usage.completion_tokens ?? 0;
    }
  }

  if (batchBuffer) yield { type: 'token', text: batchBuffer };

  // Estimate tokens if not provided by the stream
  if (!outputTokens) outputTokens = Math.ceil(fullContent.length / 4);

  yield { type: 'done', content: fullContent, model, provider, usage: { inputTokens, outputTokens } };
}

async function* streamWithAnthropic(
  apiKey: string,
  model: string,
  messages: AIMessage[],
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean,
): AsyncGenerator<StreamEvent> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });

  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  const outgoingMessages: Array<{ role: 'user' | 'assistant'; content: string }> = nonSystem.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Anthropic has no native `response_format: json_object`. For JSON mode we
  // use FORCED TOOL USE — the canonical approach for Claude 4+. We define a
  // permissive single-object tool and set `tool_choice` to require calling it,
  // so the model's output arrives as structured JSON input to the tool rather
  // than free-form text.
  //
  // (Assistant-message prefill, the older approach, is rejected by Claude 4/4.5:
  //  "This model does not support assistant message prefill.")
  if (jsonMode) {
    console.log(`[streamWithAnthropic] jsonMode=true, using forced tool use for ${model}`);
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: outgoingMessages,
      tools: [
        {
          name: 'emit_json_result',
          description:
            'Emit the structured JSON result that matches the schema described in the system prompt. Call this tool exactly once with your output as the tool input.',
          // Permissive schema — the actual shape is enforced by downstream
          // zod validation. This tool exists purely to force JSON mode.
          input_schema: {
            type: 'object' as const,
          },
        },
      ],
      tool_choice: { type: 'tool' as const, name: 'emit_json_result' },
      stream: true,
    });

    let fullContent = '';
    let batchBuffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of response) {
      if (
        event.type === 'content_block_delta' &&
        (event.delta as { type?: string }).type === 'input_json_delta'
      ) {
        const chunk = (event.delta as { partial_json?: string }).partial_json ?? '';
        if (chunk) {
          fullContent += chunk;
          batchBuffer += chunk;
          if (batchBuffer.length >= 20) {
            yield { type: 'token', text: batchBuffer };
            batchBuffer = '';
          }
        }
      } else if (event.type === 'message_delta') {
        outputTokens = (event as any).usage?.output_tokens ?? outputTokens;
      } else if (event.type === 'message_start') {
        inputTokens = (event as any).message?.usage?.input_tokens ?? 0;
      }
    }

    if (batchBuffer) yield { type: 'token', text: batchBuffer };

    console.log(`[streamWithAnthropic] tool-use complete`, {
      contentLength: fullContent.length,
      contentPreview: fullContent.slice(0, 200),
    });

    yield {
      type: 'done',
      content: fullContent,
      model,
      provider: 'anthropic',
      usage: { inputTokens, outputTokens },
    };
    return;
  }

  // Non-jsonMode path: standard text streaming.
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: outgoingMessages,
    stream: true,
  });

  let fullContent = '';
  let batchBuffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of response) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const text = event.delta.text;
      fullContent += text;
      batchBuffer += text;
      if (batchBuffer.length >= 20 || /[.!?\n]$/.test(batchBuffer)) {
        yield { type: 'token', text: batchBuffer };
        batchBuffer = '';
      }
    } else if (event.type === 'message_delta') {
      outputTokens = (event as any).usage?.output_tokens ?? outputTokens;
    } else if (event.type === 'message_start') {
      inputTokens = (event as any).message?.usage?.input_tokens ?? 0;
    }
  }

  if (batchBuffer) yield { type: 'token', text: batchBuffer };

  yield {
    type: 'done',
    content: fullContent,
    model,
    provider: 'anthropic',
    usage: { inputTokens, outputTokens },
  };
}

const OPENAI_COMPATIBLE_BASE_URLS: Partial<Record<AIProviderKey, string>> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  grok: 'https://api.x.ai/v1',
};

/**
 * Send a chat completion request to the specified AI provider.
 */
export async function completeAI(req: AICompletionRequest): Promise<AICompletionResponse> {
  const config = await getConfig();
  const maxTokens = req.maxTokens ?? 2048;
  const temperature = req.temperature ?? 0.3;

  // Ollama uses host URL, not API key. Prefer the dedicated completion host,
  // fall back to the shared embedding host for backward compatibility.
  if (req.provider === 'ollama') {
    let host = config.ollamaCompletionHost || config.ollamaHost;

    // Fleet router: resolve completion host dynamically if orchestrator is enabled for completion
    if (config.completionUseOrchestrator) {
      try {
        const { resolveEndpoint, releaseEndpoint } = await import('@/lib/gpu/fleet-router');
        const ep = await resolveEndpoint('completion');
        host = ep.host;
         console.log(`[completeAI] Route: completion → ${ep.host} (sidecar=${ep.sidecarUrl}), model=${req.model}, messages=${req.messages.length}, orchestrator=true`);
        // Release after completion (fire-and-forget)
        const result = await completeWithOllama(host, req.model, req.messages, maxTokens, temperature, req.jsonMode, req.thinking);
        releaseEndpoint('completion', ep.sidecarUrl);
        return result;
      } catch (err) {
        console.warn(`[completeAI] Orchestrator completion failed, falling back to direct host:`, (err as Error).message);
      }
    }

    console.log(`[completeAI] Route: completion → ${host} (direct), model=${req.model}, messages=${req.messages.length}, orchestrator=false`);

    if (!host) {
      throw new Error('No Ollama host configured. Set it in Admin > Local AI or Embedding Config.');
    }
    return completeWithOllama(host, req.model, req.messages, maxTokens, temperature, req.jsonMode, req.thinking);
  }

  const apiKey = getApiKey(config, req.provider);

  if (req.provider === 'anthropic') {
    return completeWithAnthropic(apiKey, req.model, req.messages, maxTokens, temperature, req.jsonMode);
  }

  const baseURL = OPENAI_COMPATIBLE_BASE_URLS[req.provider];
  if (!baseURL) {
    throw new Error(`Unknown provider: ${req.provider}`);
  }

  return completeWithOpenAICompatible(
    apiKey, baseURL, req.model, req.messages, maxTokens, temperature, req.provider, req.jsonMode,
  );
}

/**
 * Lightweight key validation — makes a tiny API call to check the key works.
 */
export async function testApiKey(provider: AIProviderKey, apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    // Ollama uses host URL — test by sending a tiny chat request
    if (provider === 'ollama') {
      const { Ollama } = await import('ollama');
      const client = new Ollama({ host: apiKey }); // apiKey is actually the host URL
      // List models to check connectivity (doesn't require a model to be loaded)
      await client.list();
      return { valid: true };
    }

    if (provider === 'anthropic') {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return { valid: true };
    }

    const baseURL = OPENAI_COMPATIBLE_BASE_URLS[provider];
    if (!baseURL) return { valid: false, error: `Unknown provider: ${provider}` };

    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey, baseURL });

    // Use the cheapest/fastest model available for each provider
    const testModel = provider === 'openai' ? 'gpt-4o-mini'
      : provider === 'groq' ? 'llama-3.1-8b-instant'
      : 'grok-3-mini';

    await client.chat.completions.create({
      model: testModel,
      max_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { valid: true };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid_api_key') || msg.includes('authentication')) {
      return { valid: false, error: 'Invalid API key' };
    }
    // Could be rate limit or other transient error — key might still be valid
    if (msg.includes('429') || msg.includes('rate')) {
      return { valid: true };
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return { valid: false, error: 'Connection refused — is Ollama running?' };
    }
    return { valid: false, error: msg.slice(0, 200) };
  }
}
