'use client';

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

interface CaseListProps {
  cases: CaseWithStats[];
  onCaseSelect: (caseId: string) => void;
  selectedCaseId: string | null;
}

export default function CaseList({ cases, onCaseSelect, selectedCaseId }: CaseListProps) {
  return (
    <div className="w-80 bg-gray-50 border-r border-gray-200 h-screen overflow-y-auto">
      <div className="p-6 border-b border-gray-200">
        <h2 className="text-xl font-semibold text-gray-900">Cases</h2>
        <p className="text-sm text-gray-500 mt-1">
          {cases.length} {cases.length === 1 ? 'case' : 'cases'} monitored
        </p>
      </div>

      <div className="divide-y divide-gray-200">
        {cases.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-gray-500 text-sm">No cases found</p>
            <p className="text-gray-400 text-xs mt-2">
              Add case directories to start monitoring
            </p>
          </div>
        ) : (
          cases.map((caseItem) => (
            <div
              key={caseItem.id}
              onClick={() => onCaseSelect(caseItem.id)}
              className={`
                p-4 cursor-pointer transition-colors
                ${selectedCaseId === caseItem.id 
                  ? 'bg-blue-50 border-l-4 border-blue-500' 
                  : 'hover:bg-gray-100'
                }
              `}
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-medium text-gray-900 text-sm truncate flex-1">
                  {caseItem.name}
                </h3>
                <span className="ml-2 text-xs font-semibold text-gray-600 bg-gray-200 px-2 py-1 rounded-full">
                  {caseItem.totalDocuments}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 mt-3">
                {caseItem.statusCounts.INDEXED > 0 && (
                  <span className="inline-flex items-center text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                    {caseItem.statusCounts.INDEXED} indexed
                  </span>
                )}
                {caseItem.statusCounts.PARTIAL > 0 && (
                  <span className="inline-flex items-center text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                    {caseItem.statusCounts.PARTIAL} partial
                  </span>
                )}
                {caseItem.statusCounts.QUEUED > 0 && (
                  <span className="inline-flex items-center text-xs font-medium text-gray-700 bg-gray-200 px-2 py-0.5 rounded-full">
                    {caseItem.statusCounts.QUEUED} queued
                  </span>
                )}
                {caseItem.statusCounts.PROCESSING > 0 && (
                  <span className="inline-flex items-center text-xs font-medium text-yellow-700 bg-yellow-100 px-2 py-0.5 rounded-full">
                    {caseItem.statusCounts.PROCESSING} processing
                  </span>
                )}
                {caseItem.statusCounts.ERROR > 0 && (
                  <span className="inline-flex items-center text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full">
                    {caseItem.statusCounts.ERROR} errors
                  </span>
                )}
              </div>

              <p className="text-xs text-gray-400 mt-2 truncate" title={caseItem.path}>
                {caseItem.path}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
