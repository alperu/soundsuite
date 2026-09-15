/**
 * GET/POST /api/openrouter/settings — the OpenRouter section of Config.
 *
 * `POST /api/config` cannot carry these fields: it rejects any
 * `embeddingProvider` outside `['transformers','openai','claude','ollama']`
 * and its `updateConfig()` call never forwards `openRouter*` fields even
 * though `updateConfig` itself supports them. That route is frozen/out of
 * scope here, so this is a dedicated sibling — same write-only key
 * semantics as `/api/admin/ai-keys` and `/api/config`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConfig, updateConfig } from '@/lib/db/config';
import { requireAdminApiAccess } from '@/lib/api/route-guard';

function maskKey(value: string | undefined): { configured: boolean; last4?: string } {
  if (typeof value !== 'string' || value.length === 0) return { configured: false };
  return { configured: true, last4: value.slice(-4) };
}

/** Only a non-empty string is a real write; anything else leaves the stored key alone. */
function pickWritableKey(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * The four routing policies an operator can pick for an embedding role, in the
 * sidecar's own vocabulary.
 *
 * An unrecognised value yields `undefined` — which `updateConfig` reads as
 * "leave it alone" — rather than falling back to a default. Silently rewriting
 * a mode the caller did not ask for is how a role ends up routing somewhere
 * nobody chose, and for embedding that means vectors landing in the wrong
 * space.
 */
const EMBEDDING_MODES = ['local-only', 'local-first', 'all-sources', 'cloud-only'] as const;
type EmbeddingMode = (typeof EMBEDDING_MODES)[number];

/**
 * Completion's union predates this control and spells the combined mode
 * 'hybrid' rather than 'all-sources'. Mapped here rather than renamed, so an
 * existing stored value keeps working.
 */
const COMPLETION_MODES = ['local-only', 'local-first', 'hybrid', 'cloud-only'] as const;
type CompletionMode = (typeof COMPLETION_MODES)[number];

function pickCompletionMode(raw: unknown): CompletionMode | undefined {
  const v = raw === 'all-sources' ? 'hybrid' : raw;
  return typeof v === 'string' && (COMPLETION_MODES as readonly string[]).includes(v)
    ? (v as CompletionMode)
    : undefined;
}

function pickEmbeddingMode(raw: unknown): EmbeddingMode | undefined {
  return typeof raw === 'string' && (EMBEDDING_MODES as readonly string[]).includes(raw)
    ? (raw as EmbeddingMode)
    : undefined;
}

export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'openrouter/settings');
  if (denied) return denied;

  try {
    const config = await getConfig();
    return NextResponse.json({
      apiKey: maskKey(config.openRouterApiKey),
      enabled: config.openRouterEnabled,
      embeddingModel: config.openRouterEmbeddingModel,
      codeEmbeddingModel: config.openRouterCodeEmbeddingModel,
      rerankModel: config.openRouterRerankModel,
      chatModel: config.openRouterChatModel,
      // ss-rlm-sandbox's model — filtered client-side to tools+reasoning
      // models (see admin-openrouter.tsx). Not gated by `enabled`/API key
      // like the others; it only takes effect when ss-rlm is unavailable
      // AND virtualInference.mode.rlm is set to local-first (see
      // resolveRlmEndpoint() in stream-rlm.ts).
      rlmSandboxModel: config.rlmSandboxModel,
      virtualInferenceModeRlm: config.virtualInferenceModeRlm,
      // Routing policy per embedding role — the four-way choice rendered on
      // /admin/openrouter. Stored as the sidecar's own vocabulary
      // (virtualInference.mode.<role>) rather than a separate policy enum, so
      // there is one value to reason about rather than a label and an encoding
      // that can disagree.
      virtualInferenceModeEmbedding: config.virtualInferenceModeEmbedding,
      virtualInferenceModeCodeEmbedding: config.virtualInferenceModeCodeEmbedding,
      virtualInferenceModeReranker: config.virtualInferenceModeReranker,
      virtualInferenceModeCompletion: config.virtualInferenceModeCompletion,
      dailyCapUsd: config.openRouterDailyCapUsd ?? {},
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to load OpenRouter settings';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'openrouter/settings');
  if (denied) return denied;

  try {
    const body = await request.json();

    const apiKeyWrite = pickWritableKey(body.apiKey ?? body.openRouterApiKey);

    let dailyCapUsd: Record<string, number> | undefined;
    if (body.dailyCapUsd && typeof body.dailyCapUsd === 'object') {
      dailyCapUsd = {};
      for (const [role, value] of Object.entries(body.dailyCapUsd as Record<string, unknown>)) {
        const n = typeof value === 'number' ? value : parseFloat(String(value));
        if (Number.isFinite(n) && n >= 0) dailyCapUsd[role] = n;
      }
    }

    const rerankerMode = pickEmbeddingMode(body.virtualInferenceModeReranker);

    await updateConfig({
      openRouterApiKey: apiKeyWrite,
      openRouterEnabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      openRouterEmbeddingModel: typeof body.embeddingModel === 'string' ? body.embeddingModel : undefined,
      openRouterCodeEmbeddingModel: typeof body.codeEmbeddingModel === 'string' ? body.codeEmbeddingModel : undefined,
      openRouterRerankModel: typeof body.rerankModel === 'string' ? body.rerankModel : undefined,
      openRouterChatModel: typeof body.chatModel === 'string' ? body.chatModel : undefined,
      rlmSandboxModel: typeof body.rlmSandboxModel === 'string' ? body.rlmSandboxModel : undefined,
      virtualInferenceModeRlm:
        body.virtualInferenceModeRlm === 'local-only' || body.virtualInferenceModeRlm === 'local-first'
          ? body.virtualInferenceModeRlm
          : undefined,
      virtualInferenceModeEmbedding: pickEmbeddingMode(body.virtualInferenceModeEmbedding),
      virtualInferenceModeCodeEmbedding: pickEmbeddingMode(body.virtualInferenceModeCodeEmbedding),
      virtualInferenceModeReranker: rerankerMode,
      // Keep `rerankProvider` in step with the policy. These answer the same
      // question, and reranker.ts reads the provider — so leaving it stale
      // would let the page show one policy while search used another. Only
      // cloud-only makes OpenRouter the primary; every other policy keeps vLLM
      // primary and differs in whether a fallback is allowed.
      rerankProvider: rerankerMode
        ? rerankerMode === 'cloud-only' ? 'openrouter' : 'vllm'
        : undefined,
      virtualInferenceModeCompletion: pickCompletionMode(body.virtualInferenceModeCompletion),
      openRouterDailyCapUsd: dailyCapUsd,
    });

    // Push the new settings to every connected sidecar straight away.
    //
    // Without this the openrouter block only reaches a host when it REGISTERS —
    // ws-relay.ts calls pushFullConfig on registration and nowhere else — so
    // saving a key here appears to do nothing until each sidecar happens to
    // reconnect, its Virtual Containers panel staying empty the whole time with
    // no sign that anything is pending.
    //
    // Fire-and-forget per sidecar, matching how /api/config fans out
    // pushModelRegistry: a host that is down must not fail the save, and the
    // registration push stays as the backstop that catches it later.
    let pushed = 0;
    try {
      const { getFleetStatus, pushFullConfig } = await import('@/lib/gpu/fleet-router');
      const cfg = await getConfig();
      const timeouts = {
        embedding: cfg.gpuIdleEmbeddingMin,
        completion: cfg.gpuIdleCompletionMin,
        ocr: cfg.gpuIdleOcrMin,
        reranker: cfg.gpuIdleRerankerMin,
      };
      const fleet = await getFleetStatus();
      for (const sidecar of fleet.sidecars) {
        pushed++;
        pushFullConfig(sidecar.url, timeouts).catch(() => {});
      }
    } catch {
      // Orchestration unavailable — settings are still saved, and the next
      // sidecar registration will carry them.
    }

    return NextResponse.json({ success: true, pushedToSidecars: pushed });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to save OpenRouter settings';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
