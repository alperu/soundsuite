import { NextRequest, NextResponse } from 'next/server';
import { streamAI } from '@/lib/ai/ai-provider';
import { AIProviderKey, AI_PROVIDER_KEYS } from '@/lib/ai/models';
import { getDraftChatSystemPrompt } from '@/lib/ai/draft-prompts';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

/**
 * POST /api/draft/chat
 * Context-aware chat for the draft editor — streams NDJSON with tokens and final result.
 * Optionally performs RAG against indexed case documents.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      query,
      caseId,
      caseIds,
      documentContent,
      selectedText,
      history,
      provider,
      model,
    } = body as {
      query: string;
      caseId?: string;
      caseIds?: string[];
      documentContent: string;
      selectedText?: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      provider: string;
      model: string;
    };

    // Support both single caseId and array of caseIds
    const effectiveCaseIds: string[] = caseIds?.length
      ? caseIds
      : caseId
        ? [caseId]
        : [];

    if (!query?.trim()) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    if (!provider || !AI_PROVIDER_KEYS.includes(provider as AIProviderKey)) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
    }

    if (!documentContent) {
      return NextResponse.json({ error: 'documentContent is required' }, { status: 400 });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: Record<string, any>) => {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        };

        try {
          // Optional RAG: fetch case knowledge from all linked cases
          let knowledgeContext: string | undefined;

          if (effectiveCaseIds.length > 0) {
            send({ type: 'progress', message: `Searching ${effectiveCaseIds.length} linked case(s)...` });

            try {
              const registry = await getToolRegistry();
              const allResults: Array<{ text: string; document: string; page: number; citation?: string; citationShort?: string }> = [];

              // Search each linked case
              for (const cid of effectiveCaseIds) {
                const searchResult = await registry.execute('query_case_knowledge', {
                  query: query.trim(),
                  caseId: cid,
                  limit: Math.max(5, Math.floor(15 / effectiveCaseIds.length)),
                });

                if (searchResult.success && searchResult.data?.results?.length > 0) {
                  allResults.push(...(searchResult.data.results as any[]));
                }
              }

              if (allResults.length > 0) {
                // Sort by score if available, take top 15
                const sorted = allResults
                  .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))
                  .slice(0, 15);

                knowledgeContext = sorted
                  .map((r) => {
                    const cite = r.citation || r.citationShort || `${r.document}, p.${r.page}`;
                    return `[${cite}]\n${r.text}`;
                  })
                  .join('\n\n---\n\n');

                send({
                  type: 'progress',
                  message: `Found ${sorted.length} relevant excerpts from ${effectiveCaseIds.length} case(s)`,
                });
              }
            } catch (err) {
              console.warn('[Draft Chat] RAG search failed:', err);
              send({ type: 'progress', message: 'Case document search unavailable, proceeding without context' });
            }
          }

          // Build system prompt
          const hasSelection = !!selectedText?.trim();
          const systemPrompt = getDraftChatSystemPrompt({
            hasSelection,
            documentContent,
            selectedText: hasSelection ? selectedText : undefined,
            knowledgeContext,
          });

          // Build messages array
          const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
            { role: 'system', content: systemPrompt },
          ];

          if (history && history.length > 0) {
            for (const h of history) {
              messages.push({ role: h.role, content: h.content });
            }
          }

          messages.push({ role: 'user', content: query.trim() });

          send({ type: 'progress', message: `Generating with ${provider}/${model}...` });

          let fullContent = '';

          for await (const event of streamAI({
            provider: provider as AIProviderKey,
            model,
            messages,
            maxTokens: 4096,
            temperature: 0.3,
          })) {
            if (event.type === 'token') {
              fullContent += event.text;
              send({ type: 'token', text: event.text });
            } else if (event.type === 'done') {
              send({
                type: 'result',
                data: {
                  text: event.content,
                  model: event.model,
                  provider: event.provider,
                  usage: event.usage,
                },
              });
            }
          }
        } catch (error) {
          send({ type: 'error', error: error instanceof Error ? error.message : 'Chat failed' });
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
    console.error('Draft chat error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Chat failed' },
      { status: 500 },
    );
  }
}
