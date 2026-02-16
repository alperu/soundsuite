import { NextRequest, NextResponse } from 'next/server';
import { streamAI } from '@/lib/ai/ai-provider';
import { AIProviderKey, AI_PROVIDERS, AI_PROVIDER_KEYS } from '@/lib/ai/models';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { extractPatternKeywords } from '@/lib/search/deep-search';
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
      limit = 20,
      searchMode = 'hybrid',
      workflowId,
      workflowIds,
      history,
      thinking,
      maxTokens: reqMaxTokens,
    } = body as {
      query: string;
      provider: string;
      model: string;
      caseId?: string;
      limit?: number;
      searchMode?: 'vector' | 'hybrid' | 'keyword';
      workflowId?: string;
      workflowIds?: string[];
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      thinking?: boolean;
      maxTokens?: number;
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
        const send = (obj: Record<string, any>) => {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        };

        try {
          // Step 1: Vector search via query_case_knowledge
          send({ type: 'progress', step: 'searching', message: 'Searching documents with vector similarity...' });

          const registry = await getToolRegistry();
          const searchResult = await registry.execute('query_case_knowledge', {
            query: query.trim(),
            ...(caseId ? { caseId } : {}),
            limit,
            searchMode,
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
            controller.close();
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
                limit: 30,
              });

              let added = 0;
              if (patternResult.success && patternResult.data?.results) {
                const existingKeys = new Set(
                  sources.map((s) => `${s.document}::${s.page}::${s.text.slice(0, 100)}`),
                );

                for (const r of patternResult.data.results) {
                  const key = `${r.document}::${r.page}::${r.text.slice(0, 100)}`;
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
          let contextChunks = '';
          let usedSources = 0;
          for (const s of sources) {
            const cite = s.citation || s.citationShort || `${s.document}, p.${s.page}`;
            const chunk = `[${cite}]\n${s.text}`;
            const separator = contextChunks ? '\n\n---\n\n' : '';
            if (contextChunks.length + separator.length + chunk.length > CONTEXT_CHAR_BUDGET && usedSources > 0) break;
            contextChunks += separator + chunk;
            usedSources++;
          }
          if (usedSources < sources.length) {
            console.log(`[AI Search] Context budget: using ${usedSources}/${sources.length} sources (${contextChunks.length} chars)`);
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
- For Clerk's Record: [CaseNumber CR Page] when single volume, [CaseNumber Vol CR Page] when multiple volumes (e.g., [03-25-00905-CV CR 140] or [03-25-00905-CV 2 CR 140])
- For Reporter's Record: [CaseNumber RR Page:Line] when single volume, [CaseNumber Vol RR Page:Line] when multiple volumes (e.g., [03-25-00905-CV 2 RR 184:12])
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
          for await (const event of streamAI({
            provider: provider as AIProviderKey,
            model,
            messages,
            maxTokens: reqMaxTokens ?? 2048,
            temperature: 0.3,
            thinking,
          })) {
            if (event.type === 'token') {
              fullContent += event.text;
              send({ type: 'token', text: event.text });
            } else if (event.type === 'done') {
              console.log(`[AI Search] Completed in ${Date.now() - t0}ms — ${event.usage.outputTokens} output tokens`);
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
                  })),
                  model: event.model,
                  provider: event.provider,
                  usage: event.usage,
                },
              });
            }
          }
        } catch (error) {
          send({ type: 'error', error: error instanceof Error ? error.message : 'AI search failed' });
        } finally {
          controller.close();
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
