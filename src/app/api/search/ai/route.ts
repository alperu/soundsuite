import { NextRequest, NextResponse } from 'next/server';
import { streamAI } from '@/lib/ai/ai-provider';
import { streamRlm } from '@/lib/ai/stream-rlm';
import { AIProviderKey, AI_PROVIDERS, AI_PROVIDER_KEYS } from '@/lib/ai/models';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { extractPatternKeywords } from '@/lib/search/deep-search';
import { sourceDedupKey } from '@/lib/search/source-dedup';
import { buildCiteContext } from '@/lib/search/context-builder';
import { pickProvenance } from '@/lib/search/chunk-provenance';
import { prisma } from '@/lib/db/prisma';

/**
 * POST /api/search/ai
 * RAG pipeline: embed query -> vector search -> build context -> LLM completion
 * Streams NDJSON: progress events followed by the final result.
 *
 * Each line is one of:
 *   {"type":"progress","step":"searching","message":"..."}
 *   {"type":"result","data":{...}}
 *   {"type":"error","error":"..."}
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      query,
      provider,
      model,
      caseId,
      chatId,
      limit = 20,
      searchMode = 'hybrid',
      mode,
      workflowId,
      workflowIds,
      history,
      thinking,
      maxTokens: reqMaxTokens,
      effort,
      useRlm,
      whereClauses,
    } = body as {
      query: string;
      provider: string;
      model: string;
      caseId?: string;
      chatId?: string;
      limit?: number;
      searchMode?: 'vector' | 'hybrid' | 'keyword';
      mode?: 'legacy' | 'boolean';
      workflowId?: string;
      workflowIds?: string[];
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      thinking?: boolean;
      maxTokens?: number;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      useRlm?: boolean;
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
    // Relax model validation for Ollama — users can pull arbitrary models
    if (provider !== 'ollama' && (!model || !providerDef.models.some(m => m.id === model))) {
      return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    }

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
          console.log('[AI Search] Client aborted — closing stream');
          safeClose();
        };
        request.signal.addEventListener('abort', onAbort);

        try {
          // Step 1: Vector search via query_case_knowledge
          send({ type: 'progress', step: 'searching', message: 'Searching documents with vector similarity...' });

          const registry = await getToolRegistry();
          const searchResult = await registry.execute('query_case_knowledge', {
            query: query.trim(),
            ...(caseId ? { caseId } : {}),
            ...(chatId ? { chatId } : {}),
            ...(whereClauses && whereClauses.length > 0 ? { whereClauses } : {}),
            limit,
            searchMode,
            ...(mode ? { mode } : {}),
          });

          if (!searchResult.success) {
            const errorMsg = searchResult.error ?? 'Unknown error';
            const isEmbedError = errorMsg.includes("Cannot read properties of null") && errorMsg.includes("embed");
            const isDimMismatch = errorMsg.includes('dimension mismatch') || errorMsg.includes('query dim');
            send({
              type: 'error',
              error: isDimMismatch
                ? 'Embedding model changed since documents were indexed. Please reindex documents from Admin > Embedding Config.'
                : isEmbedError
                ? 'Embedding provider is not configured. Please check Admin > Embedding Config to set up an embedding provider and ensure documents have been indexed.'
                : `Vector search failed: ${errorMsg}`,
            });
            safeClose();
            return;
          }

          let sources: Array<{
            text: string;
            document: string;
            page: number;
            score: number;
            citation?: string;
            citationShort?: string;
            filingType?: string;
            volumeNumber?: number;
            caseNumber?: string;
            filingSlug?: string;
            annotations?: string;
            // ChunkProvenance (task #13) — optional until backfilled
            documentId?: string;
            blockType?: string;
            headingPath?: string;
            speakers?: string;
            tableMarkdown?: string;
          }> = searchResult.data?.results ?? [];

          send({ type: 'progress', step: 'searching', message: `Found ${sources.length} matches`, detail: { vectorHits: sources.length, searchMode } });

          // Step 1b: Supplementary pattern search

          try {
            const keywords = extractPatternKeywords(query.trim());
            if (keywords.length > 0) {
              const pattern = keywords.map((kw) => `\\b${kw}\\b`).join('|');
              const patternResult = await registry.execute('scan_for_pattern', {
                pattern,
                ...(caseId ? { caseId } : {}),
                ...(chatId ? { chatId } : {}),
                // The pattern arm feeds the same `sources` array as the vector
                // arm, so it has to honour the scope too — otherwise an active
                // graph scope leaks out-of-scope excerpts into the answer.
                ...(whereClauses && whereClauses.length > 0 ? { whereClauses } : {}),
                limit: 30,
              });

              let added = 0;
              if (patternResult.success && patternResult.data?.results) {
                const existingKeys = new Set(
                  sources.map((s) => sourceDedupKey(s.document, s.page, s.text)),
                );

                for (const r of patternResult.data.results) {
                  const key = sourceDedupKey(r.document, r.page, r.text);
                  if (!existingKeys.has(key)) {
                    sources.push({
                      text: r.text,
                      document: r.document,
                      page: r.page,
                      score: 0.65,
                      citation: r.citation,
                      citationShort: r.citationShort,
                      filingType: r.filingType,
                      volumeNumber: r.volumeNumber,
                      caseNumber: r.caseNumber,
                      filingSlug: r.filingSlug,
                    });
                    existingKeys.add(key);
                    added++;
                  }
                }
                if (added > 0) {
                  console.log(`[AI Search] Pattern search added ${added} new chunks`);
                }
              }
              send({ type: 'progress', step: 'pattern_searching', message: `Pattern search: ${keywords.join(', ')}`, detail: { keywords, patternHits: added, newChunksAdded: added } });
            } else {
              send({ type: 'progress', step: 'pattern_searching', message: 'No pattern keywords extracted' });
            }
          } catch (patternErr) {
            console.warn('[AI Search] Pattern search failed:', patternErr);
            send({ type: 'progress', step: 'pattern_searching', message: 'Pattern search failed' });
          }

          // Step 2: Build context — budget ~12k chars (~3k tokens) to leave room
          // for system prompt, history, and generation within the context window.

          const CONTEXT_CHAR_BUDGET = 12_000;
          const ctx = buildCiteContext(sources, {
            maxTotalChars: CONTEXT_CHAR_BUDGET,
            separator: '\n\n---\n\n',
            trailingNewline: false,
          });
          const contextChunks = ctx.contextBlock;
          const usedSources = ctx.usedCount;
          if (usedSources < sources.length) {
            console.log(`[AI Search] Context budget: using ${usedSources}/${sources.length} sources (${ctx.totalChars} chars, ${ctx.skippedCount} skipped, ${ctx.truncatedCount} truncated)`);
          }

          send({
            type: 'progress', step: 'building_context',
            message: `Using ${usedSources}/${sources.length} sources (${(contextChunks.length / 1000).toFixed(1)}k chars)`,
            detail: {
              totalSources: sources.length, usedSources, contextChars: contextChunks.length,
              topCitations: sources.slice(0, 5).map(s => s.citationShort || s.citation || s.document),
            },
          });

          // Step 2b: Load workflow context if any
          let workflowContext = '';
          const allWorkflowIds = workflowIds || (workflowId ? [workflowId] : []);
          if (allWorkflowIds.length > 0) {
            try {
              const workflows = await prisma.workflow.findMany({
                where: { id: { in: allWorkflowIds } },
                select: { title: true, content: true },
              });
              if (workflows.length > 0) {
                workflowContext = '\n\n## Active Workflow Context\n\n' +
                  workflows.map(w => `### ${w.title}\n\n${w.content}`).join('\n\n---\n\n');
              }
            } catch (err) {
              console.warn('[AI Search] Failed to load workflow context:', err);
            }
          }

          // Step 3: Call LLM
          send({ type: 'progress', step: 'generating', message: `Generating with ${provider}/${model}...`, detail: { provider, model } });

          const systemPrompt = `You are a legal research assistant analyzing court documents. Answer the user's question based ONLY on the provided document excerpts. Be concise — give a direct answer with key citations, not an exhaustive review. Cite your sources using the citation references provided in brackets (e.g., [2 CR 140] for Clerk's Record, [3 RR 184:12] for Reporter's Record). If the answer cannot be determined from the provided excerpts, say so clearly.

When citing sources:
- Use the exact citation format shown in brackets before each excerpt
- For Clerk's Record: [CaseNumber CR Page] when single volume, [CaseNumber Vol CR Page] when multiple volumes (e.g., [03-25-00333-CV CR 140] or [03-25-00333-CV 2 CR 140])
- For Reporter's Record: [CaseNumber RR Page:Line] when single volume, [CaseNumber Vol RR Page:Line] when multiple volumes (e.g., [03-25-00333-CV 2 RR 184:12])
- For other documents: use the citation as provided
- Always include the case number when available
${workflowContext}

## Document Excerpts

${contextChunks || '(No relevant documents found)'}`;

          console.log(`[AI Search] Calling ${provider}/${model} with ${sources.length} sources (${contextChunks.length} chars context)`);
          const t0 = Date.now();

          const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
            { role: 'system', content: systemPrompt },
          ];
          if (history && history.length > 0) {
            for (const h of history) {
              messages.push({ role: h.role, content: h.content });
            }
          }
          messages.push({ role: 'user', content: query.trim() });

          let fullContent = '';
          let completed = false;

          // Drain a token/done/error stream into the SSE channel. Returns the
          // error message if the stream yielded a terminal 'error' event (RLM
          // emits these for "no sidecar" / unreachable / HTTP / stream errors),
          // else null. Sets `completed` once a final result is sent.
          const drain = async (
            stream: AsyncIterable<{ type: string; text?: string; content?: string; model?: string; provider?: string; usage?: { outputTokens?: number }; message?: string }>,
          ): Promise<string | null> => {
            for await (const event of stream) {
              if (event.type === 'token') {
                fullContent += event.text ?? '';
                send({ type: 'token', text: event.text ?? '' });
              } else if (event.type === 'done') {
                console.log(`[AI Search] Completed in ${Date.now() - t0}ms — ${event.usage?.outputTokens ?? 0} output tokens`);
                completed = true;
                send({
                  type: 'result',
                  data: {
                    answer: event.content,
                    sources: sources.map(s => ({
                      text: s.text,
                      document: s.document,
                      page: s.page,
                      score: s.score,
                      citation: s.citation,
                      citationShort: s.citationShort,
                      filingType: s.filingType,
                      volumeNumber: s.volumeNumber,
                      caseNumber: s.caseNumber,
                      filingSlug: s.filingSlug,
                      annotations: s.annotations,
                      ...pickProvenance(s),
                    })),
                    model: event.model,
                    provider: event.provider,
                    usage: event.usage,
                  },
                });
              } else if (event.type === 'error') {
                return event.message ?? 'stream error';
              }
            }
            return null;
          };

          const aiOpts = {
            provider: provider as AIProviderKey,
            model,
            messages,
            maxTokens: reqMaxTokens ?? 2048,
            temperature: 0.3,
            thinking,
            effort,
          };

          if (useRlm) {
            const rlmErr = await drain(streamRlm({
              messages,
              maxTokens: reqMaxTokens ?? 2048,
              temperature: 0.3,
              signal: request.signal,
            }));
            if (rlmErr && !completed && !fullContent) {
              // RLM down/unreachable and nothing streamed yet — SKIP it and
              // answer with the standard provider instead of a silent hang (the
              // previous behavior: the 'error' event was dropped and the stream
              // closed empty). This is the "RLM down → skip" contract.
              console.warn(`[AI Search] RLM unavailable — falling back to ${provider}/${model}: ${rlmErr}`);
              const aiErr = await drain(streamAI(aiOpts));
              if (aiErr && !completed) send({ type: 'error', error: aiErr });
            } else if (rlmErr && !completed) {
              // RLM failed AFTER streaming partial tokens — can't cleanly switch
              // providers mid-answer, so surface the error rather than hang.
              send({ type: 'error', error: rlmErr });
            }
          } else {
            const aiErr = await drain(streamAI(aiOpts));
            if (aiErr && !completed) send({ type: 'error', error: aiErr });
          }
        } catch (error) {
          send({ type: 'error', error: error instanceof Error ? error.message : 'AI search failed' });
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
    console.error('AI search error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'AI search failed' },
      { status: 500 },
    );
  }
}
