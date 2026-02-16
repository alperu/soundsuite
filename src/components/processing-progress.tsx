'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface ProgressStats {
  total: number;
  processed: number;
  queued: number;
  processing: number;
  error: number;
  rate: number; // documents per minute
  eta: number | null; // seconds remaining
  isComplete: boolean;
}

interface ProcessingProgressProps {
  caseId?: string; // Optional: filter by case
}

export default function ProcessingProgress({ caseId }: ProcessingProgressProps) {
  const [stats, setStats] = useState<ProgressStats>({
    total: 0,
    processed: 0,
    queued: 0,
    processing: 0,
    error: 0,
    rate: 0,
    eta: null,
    isComplete: true,
  });

  useEffect(() => {
    // Create EventSource for SSE
    const url = caseId 
      ? `/api/progress?caseId=${caseId}` 
      : '/api/progress';
    
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setStats(data);
      } catch (error) {
        console.error('Failed to parse progress data:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [caseId]);

  // --- Pipeline config sliders (hooks must be before any early return) ---
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pipelineConfig, setPipelineConfig] = useState({
    embeddingBatchSize: 50,
    ocrConcurrency: 2,
    ocrThreshold: 50,
    parsingWorkerCount: 1,
  });
  const [configLoaded, setConfigLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch current pipeline config on mount
  useEffect(() => {
    fetch('/api/config')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setPipelineConfig({
            embeddingBatchSize: data.embeddingBatchSize ?? 50,
            ocrConcurrency: data.ocrConcurrency ?? 2,
            ocrThreshold: data.ocrThreshold ?? 50,
            parsingWorkerCount: data.parsingWorkerCount ?? 1,
          });
          setConfigLoaded(true);
        }
      })
      .catch(() => {});
  }, []);

  const savePipelineConfig = useCallback((updates: Partial<typeof pipelineConfig>) => {
    const merged = { ...pipelineConfig, ...updates };
    setPipelineConfig(merged);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetch('/api/config/pipeline', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      }).catch(() => {});
    }, 500);
  }, [pipelineConfig]);

  // Don't show progress bar if there are no documents
  if (stats.total === 0) {
    return null;
  }

  // Calculate progress percentage
  const progressPercentage = stats.total > 0
    ? Math.round((stats.processed / stats.total) * 100)
    : 0;

  // Format ETA
  const formatETA = (seconds: number | null): string => {
    if (seconds === null || seconds === 0) return 'Calculating...';

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  };

  // Format rate
  const formatRate = (rate: number): string => {
    return rate.toFixed(1);
  };

  return (
    <div className="bg-white border-b border-gray-200 px-6 py-4">
      {stats.isComplete ? (
        // Completion message
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <svg 
              className="w-5 h-5 text-green-500 mr-2" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={2} 
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" 
              />
            </svg>
            <span className="text-sm font-medium text-green-700">
              All documents processed
            </span>
          </div>
          <div className="text-sm text-gray-500">
            {stats.processed} of {stats.total} documents indexed
          </div>
        </div>
      ) : (
        // Active processing display
        <div className="space-y-3">
          {/* Progress bar */}
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-gray-700">
              Processing documents...
            </span>
            <span className="text-gray-600">
              {stats.processed} / {stats.total} ({progressPercentage}%)
            </span>
          </div>
          
          <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
            <div 
              className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>

          {/* Stats row */}
          <div className="flex items-center justify-between text-xs text-gray-600">
            <div className="flex items-center space-x-4">
              {/* Processing rate */}
              {stats.rate > 0 && (
                <div className="flex items-center">
                  <svg 
                    className="w-4 h-4 mr-1 text-blue-500" 
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path 
                      strokeLinecap="round" 
                      strokeLinejoin="round" 
                      strokeWidth={2} 
                      d="M13 10V3L4 14h7v7l9-11h-7z" 
                    />
                  </svg>
                  <span>{formatRate(stats.rate)} docs/min</span>
                </div>
              )}

              {/* ETA */}
              {stats.eta !== null && stats.rate > 0 && (
                <div className="flex items-center">
                  <svg 
                    className="w-4 h-4 mr-1 text-gray-500" 
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path 
                      strokeLinecap="round" 
                      strokeLinejoin="round" 
                      strokeWidth={2} 
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" 
                    />
                  </svg>
                  <span>ETA: {formatETA(stats.eta)}</span>
                </div>
              )}
            </div>

            {/* Status breakdown */}
            <div className="flex items-center space-x-3">
              {stats.processing > 0 && (
                <span className="text-yellow-600">
                  {stats.processing} processing
                </span>
              )}
              {stats.queued > 0 && (
                <span className="text-gray-500">
                  {stats.queued} queued
                </span>
              )}
              {stats.error > 0 && (
                <span className="text-red-600">
                  {stats.error} failed
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Processing Settings */}
      {configLoaded && (
        <div className="mt-3 border-t border-gray-100 pt-2">
          <button
            onClick={() => setSettingsOpen(!settingsOpen)}
            className="flex items-center text-xs text-gray-500 hover:text-gray-700 transition-colors"
          >
            <svg
              className={`w-3 h-3 mr-1 transition-transform ${settingsOpen ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Processing Settings
          </button>

          {settingsOpen && (
            <div className="mt-3 grid grid-cols-4 gap-6">
              {/* PDF Parsing Concurrency */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  PDF Concurrency: {pipelineConfig.parsingWorkerCount}
                </label>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={pipelineConfig.parsingWorkerCount}
                  onChange={e => savePipelineConfig({ parsingWorkerCount: Number(e.target.value) })}
                  className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                  <span>1</span>
                  <span>5</span>
                </div>
              </div>

              {/* Embedding Batch Size */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Embedding Batch Size: {pipelineConfig.embeddingBatchSize}
                </label>
                <input
                  type="range"
                  min={10}
                  max={200}
                  step={10}
                  value={pipelineConfig.embeddingBatchSize}
                  onChange={e => savePipelineConfig({ embeddingBatchSize: Number(e.target.value) })}
                  className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                  <span>10</span>
                  <span>200</span>
                </div>
              </div>

              {/* OCR Concurrency */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  OCR Concurrency: {pipelineConfig.ocrConcurrency}
                </label>
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={1}
                  value={pipelineConfig.ocrConcurrency}
                  onChange={e => savePipelineConfig({ ocrConcurrency: Number(e.target.value) })}
                  className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                  <span>1</span>
                  <span>8</span>
                </div>
              </div>

              {/* OCR Text Threshold */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  OCR Text Threshold: {pipelineConfig.ocrThreshold}%
                </label>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={pipelineConfig.ocrThreshold}
                  onChange={e => savePipelineConfig({ ocrThreshold: Number(e.target.value) })}
                  className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                  <span>10%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
