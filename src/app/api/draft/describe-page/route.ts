import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import * as lancedb from '@lancedb/lancedb';
import { streamAI, type AIMessage } from '@/lib/ai/ai-provider';
import { AI_PROVIDER_KEYS, type AIProviderKey } from '@/lib/ai/models';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';

/**
 * POST /api/draft/describe-page
 * AI-powered page/image description for exhibit generation.
 * Streams NDJSON with { type: 'token'|'result'|'error' }.
 *
 * Fetches actual page text from LanceDB chunks and PageCache,
 * then sends it to the AI for description.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { documentId, pageNum, provider, model, caseId, imageBase64 } = body as {
      documentId?: string;
      pageNum?: number;
      provider: string;
      model: string;
      caseId?: string;
      imageBase64?: string;
    };

    if (!provider || !AI_PROVIDER_KEYS.includes(provider as AIProviderKey)) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
    }

    // Build context for the AI
    let pageContext = '';

    if (documentId && pageNum) {
      const doc = await prisma.document.findUnique({
        where: { id: documentId },
        select: { fileName: true, filePath: true, documentSummary: true, documentType: true },
      });

      if (!doc) {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 });
      }

      // 1. Try PageCache first (has full extracted text per page)
      let pageText = '';
      try {
        const cacheEntry = await (prisma as any).pageCache.findFirst({
          where: { documentId, pageNumber: pageNum },
          select: { text: true, source: true },
        });
        if (cacheEntry?.text?.trim()) {
          pageText = cacheEntry.text;
        }
      } catch {
        // PageCache may not exist
      }

      // 2. If no PageCache, get text chunks from LanceDB
      if (!pageText) {
        try {
          const db = await lancedb.connect(LANCEDB_PATH);
          const tableNames = await db.tableNames();
          if (tableNames.includes('chunks')) {
            const table = await db.openTable('chunks');
            const escapedDocId = documentId.replace(/'/g, "''");
            const rows = await table.query()
              .select(['text', 'page_number'])
              .where(`document_id = '${escapedDocId}' AND page_number = ${pageNum}`)
              .toArray();

            if (rows.length > 0) {
              pageText = rows.map((r: any) => r.text as string).join('\n\n');
            }
          }
        } catch {
          // LanceDB not available
        }
      }

      // Build context with actual page content
      pageContext = `Document: "${doc.fileName}", Page ${pageNum}`;
      if (doc.documentType) pageContext += `\nDocument type: ${doc.documentType}`;

      if (pageText) {
        pageContext += `\n\n--- PAGE ${pageNum} CONTENT ---\n${pageText.slice(0, 8000)}\n--- END PAGE CONTENT ---`;
      } else {
        pageContext += `\n\n[No extracted text available for this page. It may be a scanned image or blank page.]`;
        if (doc.documentSummary) pageContext += `\nDocument summary: ${doc.documentSummary}`;
      }
    } else if (imageBase64) {
      pageContext = '[An image was provided for analysis. Describe what you can infer from the context.]';
    } else {
      return NextResponse.json({ error: 'Either documentId+pageNum or imageBase64 is required' }, { status: 400 });
    }

    const systemPrompt = `You are a legal document analyst. Your task is to describe a document page for use as an exhibit reference in a court motion or legal brief.

Provide a concise but thorough description that includes:
- What type of document this page is from (contract, letter, invoice, deposition, etc.)
- Key dates, parties, or names mentioned
- The relevant content or significance of this page
- Any notable features (signatures, stamps, handwritten notes)

Write in a professional legal style, 2-4 sentences. Do not speculate beyond what the text shows.`;

    const messages: AIMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Please describe this document page for use as an exhibit:\n\n${pageContext}` },
    ];

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: Record<string, any>) => {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        };

        try {
          let fullText = '';

          for await (const event of streamAI({
            provider: provider as AIProviderKey,
            model,
            messages,
            maxTokens: 512,
            temperature: 0.3,
          })) {
            if (event.type === 'token') {
              fullText += event.text;
              send({ type: 'token', text: event.text });
            } else if (event.type === 'done') {
              send({ type: 'result', text: event.content || fullText });
            }
          }
        } catch (err: any) {
          send({ type: 'error', error: err.message || 'AI generation failed' });
        }

        controller.close();
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed' }, { status: 500 });
  }
}
