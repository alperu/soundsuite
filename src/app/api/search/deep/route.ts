import { NextRequest, NextResponse } from 'next/server';
import { AIProviderKey, AI_PROVIDERS, AI_PROVIDER_KEYS } from '@/lib/ai/models';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { deepSearch, DeepSearchProgress, ConversationTurn } from '@/lib/search/deep-search';
import { pickProvenance } from '@/lib/search/chunk-provenance';
import { prisma } from '@/lib/db/prisma';
import { requireApiAccess } from '@/lib/api/route-guard';

/**
 * POST /api/search/deep
 * Streams NDJSON: progress events followed by the final result.
 *
 * Each line is one of:
 *   {"type":"progress","step":"decomposing","message":"...","subQueries":[],...}
 *   {"type":"result","data":{...}}
 *   {"type":"error","error":"..."}
 *
 * Guarded (v6 item 2): this route reads case documents and calls an LLM, so an
 * unauthenticated caller could both spend API credit and exfiltrate case text.
 * It takes the same origin/API-key rule as `/api/mcp/execute` — the dashboard
 * calls it same-origin over loopback and is unaffected; neither the bridge nor
 * the sidecar calls it. A live admin session also passes, so a deployment
 * served through the Cloudflare tunnel keeps working for a signed-in operator.
 * Under `MCP_AUTH_STRICT_LOOPBACK=routed` even loopback needs a credential —
 * this is a `routed` call, and that knob exists for the calls that spend money.
 * The refusal is a plain JSON 401 emitted *before* the NDJSON stream is
 * opened, so a refused client never has to parse a stream.
 */
export async function POST(request: NextRequest) {
  try {
    const denied = await requireApiAccess(request, { label: 'search/deep', profile: 'routed', allowAdminSession: true });
    if (denied) return denied;

    const body = await request.json();
    const { query, provider, model, caseId, chatId, history, workflowIds, thinking, maxTokens, effort, multiPass, useRlm, rlmMaxRounds, whereClauses } = body as {
      query: string;
      provider: string;
      model: string;
      caseId?: string;
      chatId?: string;
      history?: ConversationTurn[];
      workflowIds?: string[];
      thinking?: boolean;
      maxTokens?: number;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      multiPass?: boolean;
      useRlm?: boolean;
      rlmMaxRounds?: number;
      /** Pre-compiled LanceDB pre-filter clauses (graph scope — see
       *  `scopeToWhereClauses`). Sent INSTEAD of `caseId`, never alongside:
       *  the two AND together and would match nothing. */
      whereClauses?: string[];
    };

    if (!query?.trim()) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    if (!provider || !AI_PROVIDER_KEYS.includes(provider as AIProviderKey)) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
    }

    const providerDef = AI_PROVIDERS[provider as AIProviderKey];
    if (provider !== 'ollama' && (!model || !providerDef.models.some(m => m.id === model))) {
      return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    }

    const registry = await getToolRegistry();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const safeClose = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        };
        const send = (obj: Record<string, any>) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')); }
          catch { closed = true; }
        };

        const onAbort = () => {
          console.log('[Deep Search] Client aborted — closing stream');
          safeClose();
        };
        request.signal.addEventListener('abort', onAbort);

        const onProgress = (progress: DeepSearchProgress) => {
          send({ type: 'progress', ...progress });
        };

        try {
          // Load workflow context if any
          let workflowContext = '';
          if (workflowIds && workflowIds.length > 0) {
            try {
              const workflows = await prisma.workflow.findMany({
                where: { id: { in: workflowIds } },
                select: { title: true, content: true },
              });
              if (workflows.length > 0) {
                workflowContext = workflows.map(w => `### ${w.title}\n\n${w.content}`).join('\n\n---\n\n');
              }
            } catch (err) {
              console.warn('[Deep Search] Failed to load workflow context:', err);
            }
          }

          const result = await deepSearch(query.trim(), registry, {
            provider,
            model,
            caseId: caseId || undefined,
            chatId: chatId || undefined,
            onProgress,
            onToken: (text) => send({ type: 'token', text }),
            onThinking: (text) => send({ type: 'thinking', text }),
            onThoughts: (text) => send({ type: 'thoughts', text }),
            history: history || undefined,
            ...(workflowContext ? { workflowContext } : {}),
            thinking,
            ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
            ...(effort ? { effort } : {}),
            ...(multiPass ? { multiPass: true } : {}),
            ...(useRlm ? { useRlm: true } : {}),
            ...(typeof rlmMaxRounds === 'number' ? { rlmMaxRounds } : {}),
            ...(Array.isArray(whereClauses) && whereClauses.length > 0 ? { whereClauses } : {}),
            signal: request.signal,
          });

          send({
            type: 'result',
            data: {
              report: result.report,
              sources: result.sources.map(s => ({
                text: s.text,
                document: s.document,
                page: s.page,
                score: s.score,
                citation: s.citation,
                citationShort: s.citationShort,
                filingType: s.filingType,
                volumeNumber: s.volumeNumber,
                caseNumber: s.caseNumber,
                ...pickProvenance(s),
                matchedSubQueries: s.matchedSubQueries,
              })),
              subQueries: result.subQueries,
              intent: result.intent,
              searchStats: result.searchStats,
              model: result.model,
              provider: result.provider,
              rlmAssisted: result.rlmAssisted,
              rlmHost: result.rlmHost,
              rlmExtraSourceCount: result.rlmExtraSourceCount,
              thoughts: result.thoughts,
            },
          });
        } catch (error) {
          send({ type: 'error', error: error instanceof Error ? error.message : 'Deep search failed' });
        } finally {
          request.signal.removeEventListener('abort', onAbort);
          safeClose();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    console.error('Deep search error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Deep search failed' },
      { status: 500 },
    );
  }
}
