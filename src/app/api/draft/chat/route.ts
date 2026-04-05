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
 * Truncate cosmetic-only fields on the parsed envelope (e.g. `notes`) so a
 * verbose model response can't fail schema validation and discard all
 * otherwise-valid suggestions. Mutates in place; no-op if input isn't a
 * plain object.
 */
function sanitizeEnvelopeCosmetics(parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object') return;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.notes === 'string' && obj.notes.length > 4000) {
    obj.notes = obj.notes.slice(0, 4000);
  }
}

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

        // Structured progress helper — packs message + step + detail into the
        // shape AIThinkingLog consumes on the client.
        const sendProgress = (
          step: string,
          message: string,
          detail?: Record<string, unknown>
        ) => {
          send({ type: 'progress', step, message, ...(detail ? { detail } : {}) });
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
            sendProgress('deep_start', `Deep research across ${effectiveCaseIds.length} case(s)...`);
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
                    // Forward the full DeepSearchProgress payload — sub-queries,
                    // intent, stats — so the client thinking-log can render it.
                    const detail: Record<string, unknown> = {};
                    if (p.subQueries && p.subQueries.length > 0) detail.keywords = p.subQueries;
                    if (p.searchStats?.totalRetrieved !== undefined) detail.totalSources = p.searchStats.totalRetrieved;
                    if (p.searchStats?.finalAfterRerank !== undefined) detail.usedSources = p.searchStats.finalAfterRerank;
                    if (p.subQueryIndex !== undefined && p.subQueryTotal !== undefined) {
                      detail.patternHits = p.subQueryIndex + 1; // repurpose for "sub-query M of N"
                      detail.vectorHits = p.subQueryTotal;
                    }
                    sendProgress(
                      p.step,
                      p.message || p.step,
                      Object.keys(detail).length > 0 ? detail : undefined
                    );
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
                sendProgress(
                  'deep_done',
                  `Deep research complete — ${deepSources.length} sources across ${effectiveCaseIds.length} case(s)`,
                  {
                    totalSources: deepSources.length,
                    topCitations: deepSources.slice(0, 6).map((s) => s.citation || s.citationShort || `${s.document}, p.${s.page}`),
                  }
                );
              }
            } catch (err) {
              console.warn('[Draft Chat] Deep search failed, falling back to standard RAG:', err);
              sendProgress('deep_fallback', 'Deep research unavailable, using standard RAG');
            }
          }

          // Standard single-pass RAG — runs when deep search didn't run, OR as
          // a supplement when deep search was skipped/failed and we still have
          // linked cases.
          if (!knowledgeContext && effectiveCaseIds.length > 0) {
            sendProgress(
              'rag_search',
              `Searching ${effectiveCaseIds.length} linked case(s) (hybrid vector + keyword)...`,
              { searchMode: 'hybrid' }
            );

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

                sendProgress(
                  'rag_done',
                  `Found ${sorted.length} relevant excerpts from ${effectiveCaseIds.length} case(s)`,
                  {
                    totalSources: allResults.length,
                    usedSources: sorted.length,
                    topCitations: sorted.slice(0, 6).map((r) => r.citation || r.citationShort || `${r.document}, p.${r.page}`),
                  }
                );
              } else {
                sendProgress('rag_empty', 'No relevant excerpts found in case documents');
              }
            } catch (err) {
              console.warn('[Draft Chat] RAG search failed:', err);
              sendProgress('rag_error', 'Case document search unavailable, proceeding without context');
            }
          }

          // Search sibling drafts if vector search enabled
          if (vectorSearch && draftId) {
            try {
              sendProgress('draft_search', 'Searching content across sibling drafts...');

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
            sanitizeEnvelopeCosmetics(parsed);
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

            sendProgress('prefs_loading', 'Loading learned preferences...');
            const prefs = await summarisePreferences({
              draftId,
              caseId: draftRecord.caseId,
              documentType: draftRecord.documentType,
            });
            if (prefs.rules.length > 0 || prefs.examples.length > 0) {
              sendProgress(
                'prefs_loaded',
                `Loaded ${prefs.rules.length} preference rule(s) and ${prefs.examples.length} few-shot example(s) (~${prefs.estimatedTokens} tokens)`
              );
            } else {
              sendProgress('prefs_empty', 'No learned preferences yet — starting fresh');
            }

            const autoSuggestPrompt = getAutoSuggestPrompt({
              userQuery: query.trim(),
              documentContent,
              selectedText: hasSelection ? selectedText : undefined,
              knowledgeContext,
              preferencesMarkdown: prefs.markdown || undefined,
              maxSuggestions: 20,
            });

            console.log('[AutoSuggest][server] generating', {
              draftId,
              sessionId,
              provider,
              model: effectiveModel,
              promptChars: autoSuggestPrompt.length,
              documentChars: documentContent.length,
              jsonMode: true,
              temperature: 0.1,
              hasKnowledgeContext: !!knowledgeContext,
              knowledgeContextChars: knowledgeContext?.length ?? 0,
            });

            sendProgress(
              'generating',
              `Generating structured suggestions with ${provider}/${effectiveModel}...`,
              {
                provider,
                model: effectiveModel,
                contextChars: autoSuggestPrompt.length,
              }
            );

            let fullContent = '';
            let lastHeartbeatAt = Date.now();
            let streamError: Error | null = null;
            try {
              for await (const event of streamAI({
                provider: provider as AIProviderKey,
                model: effectiveModel,
                messages: [
                  { role: 'system', content: autoSuggestPrompt },
                  { role: 'user', content: query.trim() },
                ],
                maxTokens: reqMaxTokens || 4096,
                // Low temperature for structured output — higher values cause
                // models to deviate from JSON format.
                temperature: 0.1,
                jsonMode: true,
                thinking,
              })) {
                if (event.type === 'token') {
                  fullContent += event.text;
                  // Throttled heartbeat: emit a char-count update every ~600ms so
                  // the client thinking-log can show live progress during long runs.
                  const now = Date.now();
                  if (now - lastHeartbeatAt > 600) {
                    lastHeartbeatAt = now;
                    sendProgress('generating_tick', `Streaming response (${fullContent.length.toLocaleString()} chars)`, {
                      contextChars: fullContent.length,
                    });
                  }
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
            } catch (err) {
              streamError = err as Error;
              console.error('[AutoSuggest][server] streamAI threw', {
                error: streamError.message,
                stack: streamError.stack?.slice(0, 500),
                provider,
                model: effectiveModel,
              });
            }

            console.log('[AutoSuggest][server] stream complete', {
              fullContentChars: fullContent.length,
              fullContentPreview: fullContent.slice(0, 300),
              streamError: streamError?.message ?? null,
            });

            if (streamError) {
              send({
                type: 'error',
                error: `AI provider error: ${streamError.message}`,
                raw: fullContent.slice(0, 500),
              });
              return;
            }

            if (!fullContent || fullContent.trim().length === 0) {
              console.error('[AutoSuggest][server] empty model response');
              send({
                type: 'error',
                error: `Model returned an empty response. Check that ${provider}/${effectiveModel} is reachable and has a model loaded.`,
              });
              return;
            }

            sendProgress('parsing', `Parsing model output (${fullContent.length.toLocaleString()} chars)...`);
            const parsed = extractJsonEnvelope(fullContent);
            if (!parsed) {
              console.error('[AutoSuggest][server] extractJsonEnvelope returned null', {
                fullContentPreview: fullContent.slice(0, 500),
              });
              send({
                type: 'error',
                error: 'Could not extract JSON object from model response',
                raw: fullContent.slice(0, 500),
              });
              return;
            }

            sanitizeEnvelopeCosmetics(parsed);
            const validated = suggestionEnvelopeSchema.safeParse(parsed);
            if (!validated.success) {
              console.error('[AutoSuggest][server] schema validation failed', {
                zodErrors: validated.error.issues.slice(0, 5),
                parsedKeys: typeof parsed === 'object' && parsed ? Object.keys(parsed as object) : 'not-an-object',
              });
              send({
                type: 'error',
                error: 'Model JSON did not match the expected suggestion schema',
                raw: fullContent.slice(0, 500),
              });
              return;
            }

            console.log('[AutoSuggest][server] parsed envelope', {
              rawSuggestionCount: validated.data.suggestions.length,
              categories: validated.data.suggestions.map((s) => s.category),
            });

            if (validated.data.suggestions.length === 0) {
              console.warn('[AutoSuggest][server] model returned zero suggestions');
              sendProgress(
                'done',
                '⚠ Model returned zero suggestions. Try rephrasing your request or lowering the model temperature.'
              );
              send({ type: 'suggestions_done', count: 0 });
              return;
            }

            sendProgress(
              'parsed',
              `Parsed ${validated.data.suggestions.length} raw suggestion(s) — locating anchors in document`
            );

            // Persist each suggestion, skip those whose anchor cannot be located.
            const persisted = [];
            let index = 0;
            for (const raw of validated.data.suggestions) {
              index++;
              const row = await persistSuggestion({
                draftId,
                sessionId,
                draftVersion: draftRecord.version,
                raw,
                documentText: documentContent,
              });
              if (row) {
                persisted.push(row);
                // Emit a per-suggestion thinking-log entry showing the actual
                // proposed change. This gives the user live visibility into
                // what the model is suggesting, independent of the card UI.
                const origPreview = row.originalText.length > 40
                  ? row.originalText.slice(0, 40) + '…'
                  : row.originalText;
                const propPreview = row.proposedText.length > 40
                  ? row.proposedText.slice(0, 40) + '…'
                  : row.proposedText;
                sendProgress(
                  'suggestion_created',
                  `#${index} [${row.category}] "${origPreview}" → "${propPreview}"`,
                  { keywords: [row.category] }
                );
              } else {
                send({
                  type: 'warning',
                  message: `Could not locate "${raw.anchorText.slice(0, 40)}..." — skipped`,
                });
              }
            }

            console.log('[AutoSuggest][server] persist complete', {
              rawCount: validated.data.suggestions.length,
              persistedCount: persisted.length,
              anchorFailures: validated.data.suggestions.length - persisted.length,
            });

            // If every suggestion failed to locate its anchor, explain that
            // explicitly instead of silently finishing with count=0.
            if (persisted.length === 0) {
              console.warn('[AutoSuggest][server] all anchors failed to locate');
              sendProgress(
                'done',
                `⚠ All ${validated.data.suggestions.length} suggestions had anchor text that could not be located in the document. The model may have paraphrased instead of copying verbatim.`
              );
              send({ type: 'suggestions_done', count: 0 });
              return;
            }

            // Detect conflicts between persisted rows and stream them to the client.
            const conflictMap = detectConflicts(persisted);
            for (const row of persisted) {
              send({
                type: 'suggestion',
                suggestion: rowToDTO(row, { conflictsWith: conflictMap.get(row.id) }),
              });
            }

            sendProgress(
              'done',
              `Done — ${persisted.length} suggestion(s) ready for review`,
              { totalSources: persisted.length }
            );
            send({ type: 'suggestions_done', count: persisted.length });
            return;
          }

          // ------------------------------------------------------------
          // Default path — free-form chat (unchanged)
          // ------------------------------------------------------------
          let briefLinkedCases: Array<{ name: string; caseNumber: string | null }> = [];
          if (briefMode && effectiveCaseIds.length > 0) {
            try {
              briefLinkedCases = await prisma.case.findMany({
                where: { id: { in: effectiveCaseIds } },
                select: { name: true, caseNumber: true },
              });
            } catch (err) {
              console.warn('[Draft Chat] Failed to load linked cases for brief prompt:', err);
            }
          }
          const systemPrompt = briefMode
            ? getAppealBriefPrompt({
                documentContent,
                knowledgeContext,
                sectionType: sectionType || 'general',
                linkedCases: briefLinkedCases,
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
