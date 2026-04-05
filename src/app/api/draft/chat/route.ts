import { NextRequest, NextResponse } from 'next/server';
import { streamAI } from '@/lib/ai/ai-provider';
import { AIProviderKey, AI_PROVIDER_KEYS, AI_PROVIDERS } from '@/lib/ai/models';
import {
  getDraftChatSystemPrompt,
  getAppealBriefPrompt,
  getAutoSuggestPrompt,
  getRegenerateSuggestionPrompt,
} from '@/lib/ai/draft-prompts';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { prisma } from '@/lib/db/prisma';
import { deepSearch } from '@/lib/search/deep-search';
import { summarisePreferences } from '@/lib/draft/preferences';
import {
  persistSuggestion,
  regenerateSuggestion,
  rowToDTO,
  detectConflicts,
  extractJsonEnvelope,
} from '@/lib/draft/suggestion-persist';
import { suggestionEnvelopeSchema } from '@/lib/draft/suggestion-types';
import { randomUUID } from 'crypto';

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
      autoSuggest,
      deepSearch: deepSearchFlag,
      sessionId: clientSessionId,
      regenerateFromSuggestionId,
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
      autoSuggest?: boolean;
      deepSearch?: boolean;
      sessionId?: string;
      regenerateFromSuggestionId?: string;
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

          // ----------------------------------------------------------------
          // Deep Search integration — when deepSearch=true, run the iterative
          // multi-sub-query research flow instead of (or in addition to) the
          // single-pass RAG below. The deep-search report becomes the primary
          // knowledgeContext, and its ranked sources are merged in as citations.
          //
          // Deep Search + Auto-Suggest together means: deep-research the case
          // first, then use that rich context to produce structured suggestion
          // cards grounded in the actual record.
          // ----------------------------------------------------------------
          if (deepSearchFlag && effectiveCaseIds.length > 0) {
            send({ type: 'progress', message: 'Deep research: decomposing query...' });
            try {
              const registry = await getToolRegistry();
              // Deep search only accepts one caseId per invocation; run per case.
              const deepReports: string[] = [];
              const deepSources: Array<{ text: string; document: string; page: number; citation?: string; citationShort?: string }> = [];
              for (const cid of effectiveCaseIds) {
                const result = await deepSearch(query.trim(), registry, {
                  provider: provider as AIProviderKey,
                  model: effectiveModel,
                  caseId: cid,
                  thinking,
                  onProgress: (p) => {
                    send({ type: 'progress', message: p.message || p.step, step: p.step });
                  },
                });
                if (result.report) deepReports.push(result.report);
                for (const s of result.sources) {
                  deepSources.push({
                    text: s.text,
                    document: s.document,
                    page: s.page,
                    citation: s.citation,
                    citationShort: s.citationShort,
                  });
                }
              }
              if (deepReports.length > 0 || deepSources.length > 0) {
                // Build knowledgeContext = synthesized report(s) + underlying excerpts.
                const reportBlock = deepReports.length > 0
                  ? `## Deep Research Synthesis\n\n${deepReports.join('\n\n---\n\n')}`
                  : '';
                const sourcesBlock = deepSources.length > 0
                  ? `## Retrieved Excerpts\n\n${deepSources
                      .slice(0, 25)
                      .map((r) => {
                        const cite = r.citation || r.citationShort || `${r.document}, p.${r.page}`;
                        return `[${cite}]\n${r.text}`;
                      })
                      .join('\n\n---\n\n')}`
                  : '';
                knowledgeContext = [reportBlock, sourcesBlock].filter(Boolean).join('\n\n');
                send({
                  type: 'progress',
                  message: `Deep research complete — ${deepSources.length} sources across ${effectiveCaseIds.length} case(s)`,
                });
              }
            } catch (err) {
              console.warn('[Draft Chat] Deep search failed, falling back to standard RAG:', err);
              send({ type: 'progress', message: 'Deep research unavailable, using standard RAG' });
            }
          }

          // Standard single-pass RAG — runs when deep search didn't run, OR as
          // a supplement when deep search was skipped/failed and we still have
          // linked cases.
          if (!knowledgeContext && effectiveCaseIds.length > 0) {
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

          const hasSelection = !!selectedText?.trim();

          // ------------------------------------------------------------
          // Regenerate path — produces a single alternative suggestion
          // ------------------------------------------------------------
          if (regenerateFromSuggestionId) {
            const existing = await prisma.draftSuggestion.findUnique({
              where: { id: regenerateFromSuggestionId },
            });
            if (!existing) {
              send({ type: 'error', error: 'Suggestion not found for regeneration' });
              return;
            }
            if (existing.regenerationCount >= 3) {
              send({ type: 'error', error: 'Regeneration limit reached (max 3)' });
              return;
            }

            // Load preferences (scoped to draft)
            const draftRecord = draftId
              ? await prisma.draft.findUnique({
                  where: { id: draftId },
                  select: { documentType: true, caseId: true },
                })
              : null;
            const prefs = await summarisePreferences({
              draftId: draftId ?? existing.draftId,
              caseId: draftRecord?.caseId,
              documentType: draftRecord?.documentType,
            });

            const regeneratePrompt = getRegenerateSuggestionPrompt({
              userQuery: query.trim(),
              documentContent,
              originalText: existing.originalText,
              previousProposedText: existing.proposedText,
              previousReason: existing.reason,
              previousCategory: existing.category as never,
              preferencesMarkdown: prefs.markdown || undefined,
            });

            send({ type: 'progress', message: 'Regenerating alternative phrasing...' });

            let fullContent = '';
            for await (const event of streamAI({
              provider: provider as AIProviderKey,
              model: effectiveModel,
              messages: [
                { role: 'system', content: regeneratePrompt },
                { role: 'user', content: 'Produce one alternative suggestion as JSON.' },
              ],
              maxTokens: Math.min(reqMaxTokens || 1024, 2048),
              temperature: 0.8, // higher temp → more diverse alternative
              jsonMode: true,
            })) {
              if (event.type === 'token') {
                fullContent += event.text;
              } else if (event.type === 'done') {
                fullContent = event.content;
              }
            }

            const parsed = extractJsonEnvelope(fullContent);
            const validated = suggestionEnvelopeSchema.safeParse(parsed);
            if (!validated.success || validated.data.suggestions.length === 0) {
              send({
                type: 'error',
                error: 'Model did not return a valid alternative suggestion',
                raw: fullContent.slice(0, 500),
              });
              return;
            }

            const updated = await regenerateSuggestion(
              regenerateFromSuggestionId,
              validated.data.suggestions[0],
              documentContent
            );
            if (!updated) {
              send({ type: 'error', error: 'Failed to update suggestion' });
              return;
            }

            send({ type: 'suggestion', suggestion: rowToDTO(updated) });
            send({ type: 'regenerate_done', suggestionId: updated.id });
            return;
          }

          // ------------------------------------------------------------
          // Auto-Suggest path — structured JSON suggestions
          // ------------------------------------------------------------
          if (autoSuggest) {
            if (!draftId) {
              send({ type: 'error', error: 'draftId is required for Auto-Suggest mode' });
              return;
            }
            const draftRecord = await prisma.draft.findUnique({
              where: { id: draftId },
              select: { version: true, documentType: true, caseId: true },
            });
            if (!draftRecord) {
              send({ type: 'error', error: 'Draft not found' });
              return;
            }
            const sessionId = clientSessionId || randomUUID();

            send({ type: 'progress', message: 'Loading learned preferences...' });
            const prefs = await summarisePreferences({
              draftId,
              caseId: draftRecord.caseId,
              documentType: draftRecord.documentType,
            });

            const autoSuggestPrompt = getAutoSuggestPrompt({
              userQuery: query.trim(),
              documentContent,
              selectedText: hasSelection ? selectedText : undefined,
              knowledgeContext,
              preferencesMarkdown: prefs.markdown || undefined,
              maxSuggestions: 20,
            });

            send({
              type: 'progress',
              message: `Generating structured suggestions with ${provider}/${effectiveModel}...`,
            });

            let fullContent = '';
            for await (const event of streamAI({
              provider: provider as AIProviderKey,
              model: effectiveModel,
              messages: [
                { role: 'system', content: autoSuggestPrompt },
                { role: 'user', content: query.trim() },
              ],
              maxTokens: reqMaxTokens || 4096,
              temperature: 0.5,
              jsonMode: true,
              thinking,
            })) {
              if (event.type === 'token') {
                fullContent += event.text;
              } else if (event.type === 'done') {
                // Ensure we have the full content even if streaming was partial
                if (!fullContent) fullContent = event.content;
                send({
                  type: 'result',
                  data: {
                    text: '',
                    model: event.model,
                    provider: event.provider,
                    usage: event.usage,
                  },
                });
              }
            }

            const parsed = extractJsonEnvelope(fullContent);
            const validated = suggestionEnvelopeSchema.safeParse(parsed);
            if (!validated.success) {
              send({
                type: 'error',
                error: 'Model did not return valid suggestions JSON',
                raw: fullContent.slice(0, 500),
              });
              return;
            }

            // Persist each suggestion, skip those whose anchor cannot be located.
            const persisted = [];
            for (const raw of validated.data.suggestions) {
              const row = await persistSuggestion({
                draftId,
                sessionId,
                draftVersion: draftRecord.version,
                raw,
                documentText: documentContent,
              });
              if (row) {
                persisted.push(row);
              } else {
                send({
                  type: 'warning',
                  message: `Could not locate "${raw.anchorText.slice(0, 40)}..." — skipped`,
                });
              }
            }

            // Detect conflicts between persisted rows and stream them to the client.
            const conflictMap = detectConflicts(persisted);
            for (const row of persisted) {
              send({
                type: 'suggestion',
                suggestion: rowToDTO(row, { conflictsWith: conflictMap.get(row.id) }),
              });
            }

            send({ type: 'suggestions_done', count: persisted.length });
            return;
          }

          // ------------------------------------------------------------
          // Default path — free-form chat (unchanged)
          // ------------------------------------------------------------
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
