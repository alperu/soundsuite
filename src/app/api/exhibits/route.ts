import { NextRequest, NextResponse } from 'next/server';
import { VectorStore } from '@/lib/vector/vector-store';
import { prisma } from '@/lib/db/prisma';

export const dynamic = 'force-dynamic';

interface ExhibitResult {
  id: string;
  imagePath: string;
  ocrText: string;
  documentId: string;
  documentName: string;
  caseId: string;
  caseName: string;
  pageNumber: number;
  extractionDate: string;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const caseId = searchParams.get('caseId');

    // Initialize vector store
    const vectorStore = new VectorStore({
      dbPath: process.env.LANCEDB_PATH || './data/lancedb',
      tableName: 'chunks',
    });

    await vectorStore.initialize();

    // Build filter for exhibits only
    const filter: Record<string, any> = {
      isExhibit: true,
    };

    if (caseId) {
      filter.caseId = caseId;
    }

    // Search for all exhibits (no vector, just filter)
    const results = await vectorStore.search({
      filter,
      limit: 1000, // Get all exhibits
    });

    // Get unique exhibits (deduplicate by exhibit_path)
    const exhibitMap = new Map<string, typeof results[0]>();
    for (const result of results) {
      if (result.metadata.exhibitPath && !exhibitMap.has(result.metadata.exhibitPath)) {
        exhibitMap.set(result.metadata.exhibitPath, result);
      }
    }

    // Fetch document and case names from database
    const documentIds = Array.from(new Set(results.map(r => r.metadata.documentId)));
    const documents = await prisma.document.findMany({
      where: {
        id: {
          in: documentIds,
        },
      },
      include: {
        case: true,
      },
    });

    const documentMap = new Map(documents.map(doc => [doc.id, doc]));

    // Format results
    const exhibits: ExhibitResult[] = Array.from(exhibitMap.values()).map(result => {
      const doc = documentMap.get(result.metadata.documentId);
      
      return {
        id: result.chunkId,
        imagePath: result.metadata.exhibitPath || '',
        ocrText: result.text,
        documentId: result.metadata.documentId,
        documentName: doc?.fileName || 'Unknown',
        caseId: result.metadata.caseId,
        caseName: doc?.case.name || 'Unknown',
        pageNumber: result.metadata.pageNumber,
        extractionDate: doc?.createdAt.toISOString() || new Date().toISOString(),
      };
    });

    // Sort by extraction date (newest first)
    exhibits.sort((a, b) => new Date(b.extractionDate).getTime() - new Date(a.extractionDate).getTime());

    return NextResponse.json({ exhibits });
  } catch (error) {
    console.error('Error fetching exhibits:', error);
    return NextResponse.json(
      { error: 'Failed to fetch exhibits', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
