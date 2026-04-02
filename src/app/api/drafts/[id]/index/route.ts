import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logger';
import { extractTextFromTiptap } from '@/lib/draft/draft-text-extractor';

const logger = createLogger('draft-index');

/**
 * POST /api/drafts/[id]/index
 * Index a draft's content into the LanceDB vector store.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    // 1. Load draft
    const draft = await prisma.draft.findUnique({
      where: { id },
      include: { case: true },
    });
    if (!draft) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
    }

    // 2. Extract text from TipTap content
    const text = extractTextFromTiptap(draft.content);
    if (!text || text.trim().length === 0) {
      return NextResponse.json(
        { error: 'Draft has no text content to index' },
        { status: 400 }
      );
    }

    // 3. Set indexing status to PROCESSING
    await prisma.draft.update({
      where: { id },
      data: { indexingStatus: 'PROCESSING', indexingError: null },
    });

    // 4. Lazy imports to avoid bundling heavy deps at module level
    const { getConfig } = await import('@/lib/db/config');
    const { LangChainTextChunker } = await import('@/lib/ingestion/langchain-text-chunker');
    const { VectorStore } = await import('@/lib/vector/vector-store');
    const { EmbeddingProvider } = await import('@/lib/ingestion/embedding-provider');

    const config = await getConfig();

    // 5. Instantiate embedding provider (same pattern as reindex-pages)
    let embeddingProvider: import('@/lib/ingestion/embedding-provider').EmbeddingProvider;
    switch (config.embeddingProvider) {
      case 'openai': {
        const { OpenAIEmbeddingProvider } = await import('@/lib/ingestion/openai-embedding-provider');
        embeddingProvider = new OpenAIEmbeddingProvider(config.openaiApiKey || '', config.embeddingModel);
        break;
      }
      case 'claude': {
        const { ClaudeEmbeddingProvider } = await import('@/lib/ingestion/claude-embedding-provider');
        embeddingProvider = new ClaudeEmbeddingProvider(config.claudeApiKey || '', config.embeddingModel);
        break;
      }
      case 'ollama': {
        const { OllamaEmbeddingProvider } = await import('@/lib/ingestion/ollama-embedding-provider');
        embeddingProvider = new OllamaEmbeddingProvider({
          host: config.ollamaHost || 'http://localhost:11434',
          model: config.ollamaModel || config.embeddingModel || 'all-minilm',
        });
        break;
      }
      default: {
        const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
        embeddingProvider = new TransformersEmbeddingProvider(config.embeddingModel);
        break;
      }
    }

    // 6. Chunk the draft text
    // Treat the entire draft as a single "page 1" so chunkPages can handle it
    const textChunker = new LangChainTextChunker();
    const pages = [{ pageNumber: 1, text, textDensity: text.length }];
    const chunks = await textChunker.chunkPages(pages, draft.id, draft.caseId);

    // 7. Enrich chunk metadata for drafts
    for (const chunk of chunks) {
      chunk.metadata.documentType = draft.documentType || undefined;
      chunk.metadata.filingType = `Draft: ${draft.documentType}`;
      chunk.metadata.caseNumber = draft.case?.caseNumber || undefined;
    }

    logger.info(`Chunked draft "${draft.title}" into ${chunks.length} chunks`);

    // 8. Generate embeddings
    const batchSize = config.embeddingBatchSize || 50;
    const embeddedChunks: import('@/lib/ingestion/embedding-provider').EmbeddedChunk[] = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(c => c.text);
      const embeddings = await embeddingProvider.embed(texts);
      for (let j = 0; j < batch.length; j++) {
        embeddedChunks.push({
          text: batch[j].text,
          embedding: embeddings[j],
          metadata: batch[j].metadata,
        });
      }
    }

    // 9. Delete old vectors for this draft, then insert new ones
    const vectorStore = new VectorStore({
      dbPath: process.env.LANCEDB_PATH || './data/lancedb',
      tableName: process.env.LANCEDB_TABLE || 'chunks',
    });
    await vectorStore.initialize();

    logger.info(`Clearing old vectors for draft ${id}`);
    await vectorStore.deleteByDocument(draft.id);

    if (embeddedChunks.length > 0) {
      await vectorStore.insertChunks(embeddedChunks);
      logger.info(`Inserted ${embeddedChunks.length} vectors for draft ${id}`);
    }

    // Cleanup
    textChunker.dispose();

    // 10. Update draft with indexing success
    await prisma.draft.update({
      where: { id },
      data: {
        indexingStatus: 'INDEXED',
        lastIndexedAt: new Date(),
        indexedVersion: draft.version,
        embeddingModel: embeddingProvider.getModelName(),
        indexingError: null,
      },
    });

    logger.info(`Draft "${draft.title}" indexed successfully: ${embeddedChunks.length} chunks`);

    return NextResponse.json({
      success: true,
      chunksIndexed: embeddedChunks.length,
    });
  } catch (error) {
    logger.error('Draft indexing failed', error);

    // Set error status
    try {
      await prisma.draft.update({
        where: { id },
        data: {
          indexingStatus: 'ERROR',
          indexingError: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // Non-critical
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to index draft' },
      { status: 500 }
    );
  }
}
