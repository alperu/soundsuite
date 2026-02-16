'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

interface DocumentRecord {
  id: string;
  fileName: string;
  filePath: string;
  status: string;
  documentType: string | null;
  exhibitLabel: string | null;
  documentSummary: string | null;
  pageCount: number | null;
  detectedExhibits: number;
  createdAt: string;
}

export default function ExhibitDetailPage() {
  const params = useParams();
  const router = useRouter();
  const caseNumberParam = decodeURIComponent(params.caseNumber as string);
  const filingSlugParam = decodeURIComponent(params.filingSlug as string);
  const exhibitLabelParam = decodeURIComponent(params.exhibitLabel as string);

  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);

    fetch(`/api/cases?caseNumber=${encodeURIComponent(caseNumberParam)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.case) { setNotFound(true); setLoading(false); return; }
        const caseId = data.case.id;
        return fetch(`/api/cases/${caseId}/filings`).then(r => r.json()).then(fd => {
          const filing = fd.filings?.find((f: any) => f.slug === filingSlugParam);
          if (!filing) { setNotFound(true); setLoading(false); return; }
          const exhibit = filing.documents?.find((d: DocumentRecord) => d.exhibitLabel === exhibitLabelParam);
          if (exhibit) setDocument(exhibit);
          else setNotFound(true);
          setLoading(false);
        });
      })
      .catch(() => { setNotFound(true); setLoading(false); });
  }, [caseNumberParam, filingSlugParam, exhibitLabelParam]);

  const backUrl = `/case-management/${encodeURIComponent(caseNumberParam)}/${encodeURIComponent(filingSlugParam)}`;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (notFound || !document) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-500 text-lg">Exhibit not found</p>
          <button onClick={() => router.push(backUrl)}
            className="mt-2 text-blue-600 text-sm hover:underline">Back to filing</button>
        </div>
      </div>
    );
  }

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      QUEUED: 'bg-gray-200 text-gray-700',
      PROCESSING: 'bg-yellow-100 text-yellow-800',
      INDEXED: 'bg-green-100 text-green-800',
      ERROR: 'bg-red-100 text-red-800',
    };
    return colors[status] || 'bg-gray-100 text-gray-600';
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 border-b border-gray-200">
        <button onClick={() => router.push(backUrl)}
          className="text-sm text-blue-600 hover:underline mb-2 inline-block">&larr; Back to filing</button>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded">{document.exhibitLabel}</span>
          <h2 className="text-lg font-semibold text-gray-900">{document.fileName}</h2>
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${getStatusBadge(document.status)}`}>{document.status}</span>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-1">File Path</h3>
          <p className="text-sm text-gray-500 break-all">{document.filePath}</p>
        </div>
        {document.pageCount && (
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-1">Pages</h3>
            <p className="text-sm text-gray-500">{document.pageCount}</p>
          </div>
        )}
        {document.detectedExhibits > 0 && (
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-1">Detected Exhibits</h3>
            <p className="text-sm text-gray-500">{document.detectedExhibits}</p>
          </div>
        )}
        {document.documentSummary && (
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-1">Summary</h3>
            <p className="text-sm text-gray-600">{document.documentSummary}</p>
          </div>
        )}
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-1">Created</h3>
          <p className="text-sm text-gray-500">{new Date(document.createdAt).toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}
