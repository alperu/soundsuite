/**
 * `virtual-chat` — OpenAI-compatible chat completions, over HTTP.
 *
 * This is the outbound path for ss-rlm-sandbox. It exists because the sandbox
 * container must make sub-model calls while holding **no API key and needing no
 * outbound internet** (docs/SPEC-ss-rlm-sandbox.md §4 — those are requirements,
 * not preferences: the Python running in that container is written by a model).
 *
 * WHY A ROUTE AND NOT AN ACTION. The existing virtual-* surface
 * (`virtual-embed`, `virtual-rerank`, `virtual-key-info`) are WebSocket actions
 * a *master* invokes on the sidecar — ws-client.ts dispatches them and each one
 * gets `m.serverUrl` for free. The sandbox needs the opposite direction,
 * container → sidecar → OpenRouter, and nothing in that surface is reachable
 * over HTTP. Hence a route.
 *
 * The container points the rlm library at it:
 *
 *   RLM(backend="openai",
 *       backend_kwargs={"base_url": "http://<sidecar>:8098/api/v1",
 *                       "api_key":  "<any non-empty string>"})
 *
 * so the library needs no OpenRouter awareness at all — it believes it is
 * talking to an OpenAI-compatible endpoint, and the real key never leaves this
 * process.
 *
 * See docs/DESIGN-ss-rlm-sandbox-runtime.md §4.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveSandboxMaster, sandboxModelFor } from '@/lib/virtual-inference';
import { chat, OpenRouterClientError } from '@/lib/openrouter-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('virtual-chat');

/** The registry role whose per-master `allowedModels` entry names the model. */
const ROLE = 'rlm-sandbox';

/**
 * Body fields we refuse to forward.
 *
 * `model` is resolved from the master's own config, never from the caller — the
 * sandbox must not be able to talk its way onto a model the operator did not
 * authorise, and a model-written loop is exactly the caller you want that to be
 * true for. Everything else (temperature, tools, max_tokens, …) rides through.
 */
const CALLER_MAY_NOT_SET = new Set(['model', 'api_key', 'apiKey']);

function err(status: number, message: string) {
  // OpenAI error envelope: the rlm library surfaces `error.message`, so a
  // misconfiguration reads as a sentence in the trace rather than "500".
  return NextResponse.json({ error: { message, type: 'sidecar_error', code: status } }, { status });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err(400, 'body must be JSON');
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return err(400, 'messages must be a non-empty array');
  }

  // Forward path for the two-master case: once a master identifies itself when
  // dialling :8101, the sandbox passes it through and ambiguity disappears.
  const explicit = req.headers.get('x-soundsuite-master') || undefined;
  const resolved = resolveSandboxMaster(explicit);
  if (!resolved.ok) {
    log.warn(`refused: ${resolved.error}`);
    return err(resolved.status, resolved.error);
  }

  const model = sandboxModelFor(resolved.config, ROLE);
  if (!model) {
    return err(
      503,
      `master ${resolved.serverUrl} has not configured a model for ${ROLE}. ` +
        `Set "RLM Sandbox fallback" on /admin/openrouter.`,
    );
  }

  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'messages' || CALLER_MAY_NOT_SET.has(k)) continue;
    passthrough[k] = v;
  }

  // Streaming is not supported: the master's sandbox path collects a whole
  // answer, and silently ignoring `stream: true` would hang a caller waiting
  // for SSE that never arrives.
  if (passthrough.stream === true) {
    return err(400, 'stream is not supported on this endpoint — request a non-streaming completion');
  }

  const started = Date.now();
  try {
    const out = await chat(resolved.config.apiKey!, model, messages, { passthrough });
    const usage = (out.usage ?? {}) as Record<string, unknown>;
    log.info(
      `${ROLE} -> ${model} for ${resolved.serverUrl} in ${Date.now() - started}ms ` +
        `(tokens=${usage.total_tokens ?? '?'}, cost=${usage.cost ?? '?'})`,
    );
    // Returned VERBATIM. `usage.cost` is what the rlm library's max_budget rail
    // reads; reshaping this response would quietly disable it.
    return NextResponse.json(out);
  } catch (e) {
    const status = e instanceof OpenRouterClientError ? e.status || 502 : 502;
    const message = (e as Error).message;
    log.error(`${ROLE} -> ${model} failed after ${Date.now() - started}ms: ${message}`);
    return err(status, message);
  }
}

/**
 * Model listing — the OpenAI client in the rlm library probes this on some
 * paths, and a 404 here reads as "endpoint is wrong" rather than
 * "model not configured".
 */
export async function GET(req: NextRequest) {
  // Must honor the same identity header as POST. Taking no argument here meant
  // a caller that correctly identified itself still got a 409 from this probe,
  // which reads as "the header does not work" rather than "this handler ignores
  // it" — and the probe is the first thing anyone tries.
  const resolved = resolveSandboxMaster(req.headers.get('x-soundsuite-master') || undefined);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const model = sandboxModelFor(resolved.config, ROLE);
  return NextResponse.json({
    object: 'list',
    data: model ? [{ id: model, object: 'model', owned_by: 'openrouter' }] : [],
  });
}
