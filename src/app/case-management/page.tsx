import Link from 'next/link';

export default function CaseManagementPage() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <p className="text-gray-500">Select a case to browse files</p>
        <Link
          href="/scope"
          className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-indigo-700 border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 6.375a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0zM16.5 6.375a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0zM10.875 17.625a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0zM6.375 7.5v3.75a2.25 2.25 0 002.25 2.25h6.75a2.25 2.25 0 002.25-2.25V7.5M12 13.5v3" />
          </svg>
          Open Haystack Block View
        </Link>
      </div>
    </div>
  );
}
