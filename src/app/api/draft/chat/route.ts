import { NextRequest, NextResponse } from 'next/server';
import { streamAI } from '@/lib/ai/ai-provider';
import { AIProviderKey, AI_PROVIDER_KEYS, AI_PROVIDERS } from '@/lib/ai/models';
import { getDraftChatSystemPrompt, getAppealBriefPrompt } from '@/lib/ai/draft-prompts';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { prisma } from '@/lib/db/prisma';

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
      thinking,
      maxTokens: reqMaxTokens,
      briefMode,
      sectionType,
      vectorSearch,
      draftId,
    } = body as {
      query: string;
      caseId?: string;
      caseIds?: string[];
      documentContent: string;
      selectedText?: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      provider: string;
      model: string;
      thinking?: boolean;
      maxTokens?: number;
      briefMode?: boolean;
      sectionType?: 'issues' | 'facts' | 'summary' | 'argument' | 'conclusion' | 'general';
      vectorSearch?: boolean;
      draftId?: string;
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

    // Relax model validation for Ollama (arbitrary models) — match search/ai behavior
    const providerDef = AI_PROVIDERS[provider as AIProviderKey];
    if (provider !== 'ollama' && model && !providerDef.models.some(m => m.id === model)) {
      // Auto-fallback to first model instead of erroring
      const fallbackModel = providerDef.models[0]?.id;
      if (fallbackModel) {
        (body as any).model = fallbackModel;
      }
    }
    const effectiveModel = (body as any).model || model || providerDef.models[0]?.id || '';

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
                  limit: 20,
                  searchMode: 'hybrid',
                });

                if (searchResult.success && searchResult.data?.results?.length > 0) {
                  allResults.push(...(searchResult.data.results as any[]));
                }
              }

              if (allResults.length > 0) {
                // Sort by score if available, take top 15
                const sorted = allResults
                  .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))
                  .slice(0, 25);

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

          // Search sibling drafts if vector search enabled
          if (vectorSearch && draftId) {
            try {
              send({ type: 'progress', message: 'Searching draft content...' });

              // Find all indexed drafts linked to the same cases
              const draftCaseLinks = await prisma.draftCase.findMany({
                where: { draftId },
                select: { caseId: true },
              });
              const linkedCaseIds = draftCaseLinks.map(dc => dc.caseId);

              const siblingDrafts = await prisma.draft.findMany({
                where: {
                  indexingStatus: 'INDEXED',
                  draftCases: { some: { caseId: { in: linkedCaseIds } } },
                },
                select: { id: true, title: true },
              });

              if (siblingDrafts.length > 0) {
                const registry = await getToolRegistry();
                const draftResults: any[] = [];
                for (const sibling of siblingDrafts) {
                  // Note: query_case_knowledge filters by caseId, not documentId.
                  // Search each linked case to find relevant content from sibling drafts.
                  for (const caseLink of draftCaseLinks) {
                    const searchResult = await registry.execute('query_case_knowledge', {
                      query: query.trim(),
                      caseId: caseLink.caseId,
                      limit: 5,
                    });
                    if (searchResult.success && searchResult.data?.results?.length > 0) {
                      for (const r of searchResult.data.results) {
                        draftResults.push({ ...r, draftTitle: sibling.title });
                      }
                    }
                  }
                }

                if (draftResults.length > 0) {
                  // Deduplicate by text content
                  const seen = new Set<string>();
                  const uniqueResults = draftResults.filter(r => {
                    const key = r.text?.slice(0, 100);
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                  });

                  const draftContext = uniqueResults
                    .map(r => `[From draft: ${r.draftTitle}]\n${r.text}`)
                    .join('\n\n---\n\n');

                  knowledgeContext = knowledgeContext
                    ? `${knowledgeContext}\n\n## Draft Content\n\n${draftContext}`
                    : draftContext;

                  send({
                    type: 'progress',
                    message: `Found ${uniqueResults.length} excerpts from ${siblingDrafts.length} draft(s)`,
                  });
                }
              }
            } catch (err) {
              console.warn('[Draft Chat] Draft vector search failed:', err);
            }
          }

          // Build system prompt — use brief prompt when in brief mode
          const hasSelection = !!selectedText?.trim();
          const systemPrompt = briefMode
            ? getAppealBriefPrompt({
                documentContent,
                knowledgeContext,
                sectionType: sectionType || 'general',
              })
            : getDraftChatSystemPrompt({
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
            model: effectiveModel,
            messages,
            maxTokens: reqMaxTokens || 4096,
            temperature: 0.7,
            thinking,
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
