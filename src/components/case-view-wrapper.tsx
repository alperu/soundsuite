'use client';

import { useState } from 'react';
import CaseList from './case-list';
import DocumentGrid from './document-grid';
import Toolbar from './toolbar';
import ProcessingProgress from './processing-progress';
import HealthStatus from './health-status';

interface CaseWithStats {
  id: string;
  name: string;
  path: string;
  totalDocuments: number;
  statusCounts: {
    QUEUED: number;
    PROCESSING: number;
    INDEXED: number;
    ERROR: number;
    PARTIAL: number;
  };
}

interface Document {
  id: string;
  fileName: string;
  status: 'QUEUED' | 'PROCESSING' | 'INDEXED' | 'ERROR' | 'STOPPED';
  pageCount: number | null;
  detectedExhibits: number;
  errorMessage: string | null;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CaseViewWrapperProps {
  cases: CaseWithStats[];
  initialDocuments: Record<string, Document[]>;
  partialDocumentIds: string[];
}

export default function CaseViewWrapper({ cases, initialDocuments, partialDocumentIds }: CaseViewWrapperProps) {
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(
    cases.length > 0 ? cases[0].id : null
  );
  const [liveDocuments, setLiveDocuments] = useState<Document[]>([]);

  const handleCaseSelect = (caseId: string) => {
    setSelectedCaseId(caseId);
  };

  const selectedCase = cases.find((c) => c.id === selectedCaseId);

  return (
    <div className="flex h-screen">
      <CaseList
        cases={cases}
        onCaseSelect={handleCaseSelect}
        selectedCaseId={selectedCaseId}
      />
      <main className="flex-1 flex flex-col">
        <HealthStatus />
        {selectedCaseId && selectedCase ? (
          <>
            <ProcessingProgress caseId={selectedCaseId} />
            <Toolbar
              caseName={selectedCase.name}
              totalDocuments={selectedCase.totalDocuments}
              documents={liveDocuments}
            />
            <DocumentGrid
              caseId={selectedCaseId}
              initialDocuments={initialDocuments[selectedCaseId] || []}
              onDocumentsUpdate={setLiveDocuments}
              partialDocumentIds={partialDocumentIds}
            />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center">
            <h1 className="text-4xl font-bold mb-4">Sound Suite</h1>
            <p className="text-xl text-gray-600">Document Intelligence Platform</p>
            <p className="text-sm text-gray-500 mt-4">Select a case from the sidebar to view documents</p>
          </div>
        )}
      </main>
    </div>
  );
}
