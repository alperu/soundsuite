'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';

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

interface ExhibitGalleryProps {
  initialExhibits: Exhibit[];
  cases: Array<{ id: string; name: string }>;
}

export default function ExhibitGallery({ initialExhibits, cases }: ExhibitGalleryProps) {
  const [exhibits, setExhibits] = useState<Exhibit[]>(initialExhibits);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedExhibit, setSelectedExhibit] = useState<Exhibit | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch exhibits when case filter changes
  useEffect(() => {
    const fetchExhibits = async () => {
      setLoading(true);
      try {
        const url = selectedCaseId 
          ? `/api/exhibits?caseId=${selectedCaseId}`
          : '/api/exhibits';
        
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          setExhibits(data.exhibits);
        }
      } catch (error) {
        console.error('Failed to fetch exhibits:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchExhibits();
  }, [selectedCaseId]);

  return (
    <div className="flex flex-col h-screen">
      {/* Header with filter */}
      <div className="bg-white border-b border-gray-200 p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Exhibit Gallery</h1>
              <p className="text-sm text-gray-500 mt-1">
                {exhibits.length} {exhibits.length === 1 ? 'exhibit' : 'exhibits'} found
              </p>
            </div>

            {/* Case filter */}
            <div className="flex items-center space-x-3">
              <label htmlFor="case-filter" className="text-sm font-medium text-gray-700">
                Filter by case:
              </label>
              <select
                id="case-filter"
                value={selectedCaseId || ''}
                onChange={(e) => setSelectedCaseId(e.target.value || null)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All Cases</option>
                {cases.map((caseItem) => (
                  <option key={caseItem.id} value={caseItem.id}>
                    {caseItem.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Gallery grid */}
      <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
        <div className="max-w-7xl mx-auto">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
                <p className="text-gray-500 mt-4">Loading exhibits...</p>
              </div>
            </div>
          ) : exhibits.length === 0 ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <svg className="w-16 h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-gray-500 text-lg">No exhibits found</p>
                <p className="text-gray-400 text-sm mt-2">
                  Exhibits will appear here once documents are processed
                </p>
              </div>
            </div>
          ) : (
            <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 space-y-4">
              {exhibits.map((exhibit) => (
                <div
                  key={exhibit.id}
                  onClick={() => setSelectedExhibit(exhibit)}
                  className="break-inside-avoid bg-white rounded-lg shadow-sm hover:shadow-lg transition-shadow cursor-pointer overflow-hidden"
                >
                  {/* Image thumbnail */}
                  <div className="relative w-full aspect-square bg-gray-100">
                    <Image
                      src={exhibit.imagePath}
                      alt={`Exhibit from ${exhibit.documentName}`}
                      fill
                      className="object-contain"
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, (max-width: 1280px) 33vw, 25vw"
                    />
                  </div>

                  {/* Metadata */}
                  <div className="p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-900 truncate" title={exhibit.documentName}>
                          {exhibit.documentName}
                        </p>
                        <p className="text-xs text-gray-500">
                          Page {exhibit.pageNumber}
                        </p>
                      </div>
                    </div>

                    {/* OCR text preview */}
                    {exhibit.ocrText && (
                      <p className="text-xs text-gray-600 line-clamp-2 mt-2">
                        {exhibit.ocrText}
                      </p>
                    )}

                    {/* Case badge */}
                    <div className="mt-2">
                      <span className="inline-block px-2 py-1 text-xs font-medium bg-blue-100 text-blue-700 rounded">
                        {exhibit.caseName}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox modal */}
      {selectedExhibit && (
        <div
          className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedExhibit(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between p-6 border-b border-gray-200">
              <div className="flex-1">
                <h2 className="text-xl font-semibold text-gray-900">
                  {selectedExhibit.documentName}
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Page {selectedExhibit.pageNumber} • {selectedExhibit.caseName}
                </p>
              </div>
              <button
                onClick={() => setSelectedExhibit(null)}
                className="ml-4 text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Image */}
            <div className="p-6">
              <div className="relative w-full" style={{ minHeight: '400px' }}>
                <Image
                  src={selectedExhibit.imagePath}
                  alt={`Exhibit from ${selectedExhibit.documentName}`}
                  width={1200}
                  height={800}
                  className="w-full h-auto rounded-lg"
                  style={{ maxHeight: '60vh', objectFit: 'contain' }}
                />
              </div>

              {/* OCR Text */}
              {selectedExhibit.ocrText && (
                <div className="mt-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2">Extracted Text (OCR)</h3>
                  <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-wrap">
                    {selectedExhibit.ocrText}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div className="mt-6 grid grid-cols-2 gap-4 pt-4 border-t border-gray-200">
                <div>
                  <label className="text-xs font-medium text-gray-500">Source Document</label>
                  <p className="text-sm text-gray-900 mt-1">{selectedExhibit.documentName}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500">Page Number</label>
                  <p className="text-sm text-gray-900 mt-1">{selectedExhibit.pageNumber}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500">Case</label>
                  <p className="text-sm text-gray-900 mt-1">{selectedExhibit.caseName}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500">Extraction Date</label>
                  <p className="text-sm text-gray-900 mt-1">
                    {new Date(selectedExhibit.extractionDate).toLocaleString()}
                  </p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end p-6 border-t border-gray-200">
              <button
                onClick={() => setSelectedExhibit(null)}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
