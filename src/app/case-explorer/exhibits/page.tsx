import { prisma } from '@/lib/db/prisma';
import { VectorStore } from '@/lib/vector/vector-store';
import ExhibitGallery from '@/components/exhibit-gallery';

interface Exhibit {
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

async function getExhibits(): Promise<Exhibit[]> {
  try {
    const vectorStore = new VectorStore({
      dbPath: process.env.LANCEDB_PATH || './data/lancedb',
      tableName: 'chunks',
    });

    await vectorStore.initialize();

    const results = await vectorStore.search({
      filter: { isExhibit: true },
      limit: 1000,
    });

    const exhibitMap = new Map<string, typeof results[0]>();
    for (const result of results) {
      if (result.metadata.exhibitPath && !exhibitMap.has(result.metadata.exhibitPath)) {
        exhibitMap.set(result.metadata.exhibitPath, result);
      }
    }

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

    const exhibits: Exhibit[] = Array.from(exhibitMap.values()).map(result => {
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

    exhibits.sort((a, b) => new Date(b.extractionDate).getTime() - new Date(a.extractionDate).getTime());

    return exhibits;
  } catch (error) {
    console.error('Error fetching exhibits:', error);
    return [];
  }
}

async function getCases() {
  const cases = await prisma.case.findMany({
    select: {
      id: true,
      name: true,
    },
    orderBy: {
      name: 'asc',
    },
  });

  return cases;
}

export default async function CaseExplorerExhibitsPage() {
  const [exhibits, cases] = await Promise.all([
    getExhibits(),
    getCases(),
  ]);

  return <ExhibitGallery initialExhibits={exhibits} cases={cases} />;
}
