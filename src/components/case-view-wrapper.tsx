'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getPreference, setPreference } from '@/lib/indexed-db';
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
  /** From /?case=... — deep-linked case selection. */
  initialCaseId?: string;
  /** From /?doc=id[,id...] — deep-linked document selection. */
  initialDocIds?: string[];
}

/** Reflect selection in the URL without a server round-trip. */
function writeSelectionToUrl(caseId: string | null, docIds: string[]) {
  const params = new URLSearchParams();
  if (caseId) params.set('case', caseId);
  // Cap so a huge shift-select doesn't blow past URL limits.
  if (docIds.length > 0 && docIds.length <= 50) params.set('doc', docIds.join(','));
  const qs = params.toString();
  window.history.replaceState(null, '', qs ? `/?${qs}` : '/');
}

export default function CaseViewWrapper({
  cases,
  initialDocuments,
  partialDocumentIds,
  initialCaseId,
  initialDocIds,
}: CaseViewWrapperProps) {
  const urlCaseValid = !!(initialCaseId && cases.some((c) => c.id === initialCaseId));
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(
    (urlCaseValid ? initialCaseId! : null) ?? (cases.length > 0 ? cases[0].id : null)
  );
  const [liveDocuments, setLiveDocuments] = useState<Document[]>([]);
  const selectedDocIdsRef = useRef<string[]>(initialDocIds ?? []);
  const [initialDocSelection, setInitialDocSelection] = useState<string[]>(initialDocIds ?? []);
  // Until stored preferences are consulted, hold off mounting the grid so its
  // one-shot initial selection reflects the restored state. URL params win
  // instantly (deep links stay snappy).
  const [prefsLoaded, setPrefsLoaded] = useState(urlCaseValid);

  // Restore last selection from IndexedDB (soundsuite-cache → preferences)
  // when the URL doesn't specify one; persist URL-provided state otherwise.
  useEffect(() => {
    if (urlCaseValid) {
      setPreference('home.selectedCaseId', initialCaseId).catch(() => {});
      setPreference('home.selectedDocIds', initialDocIds ?? []).catch(() => {});
      return;
    }
    (async () => {
      try {
        const storedCase = await getPreference<string>('home.selectedCaseId');
        const storedDocs = (await getPreference<string[]>('home.selectedDocIds')) ?? [];
        if (storedCase && cases.some((c) => c.id === storedCase)) {
          setSelectedCaseId(storedCase);
          selectedDocIdsRef.current = storedDocs;
          setInitialDocSelection(storedDocs);
          writeSelectionToUrl(storedCase, storedDocs);
        }
      } catch { /* fall back to default selection */ } finally {
        setPrefsLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCaseSelect = (caseId: string) => {
    setSelectedCaseId(caseId);
    selectedDocIdsRef.current = [];
    setInitialDocSelection([]);
    writeSelectionToUrl(caseId, []);
    setPreference('home.selectedCaseId', caseId).catch(() => {});
    setPreference('home.selectedDocIds', []).catch(() => {});
  };

  const handleDocSelectionChange = useCallback(
    (docIds: string[]) => {
      selectedDocIdsRef.current = docIds;
      writeSelectionToUrl(selectedCaseId, docIds);
      setPreference('home.selectedDocIds', docIds).catch(() => {});
    },
    [selectedCaseId],
  );

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
            {prefsLoaded && (
              <DocumentGrid
                key={selectedCaseId}
                caseId={selectedCaseId}
                initialDocuments={initialDocuments[selectedCaseId] || []}
                onDocumentsUpdate={setLiveDocuments}
                partialDocumentIds={partialDocumentIds}
                initialSelectedIds={initialDocSelection}
                onSelectionChange={handleDocSelectionChange}
              />
            )}
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
