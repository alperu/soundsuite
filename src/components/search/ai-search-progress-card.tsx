'use client';

export interface AISearchProgress {
  step: 'searching' | 'pattern_searching' | 'building_context' | 'generating' | 'done';
  message: string;
}

const STEP_LABELS: Record<string, string> = {
  searching: 'Searching Documents',
  pattern_searching: 'Pattern Search',
  building_context: 'Building Context',
  generating: 'Generating Response',
  done: 'Complete',
};

const STEP_ORDER = ['searching', 'pattern_searching', 'building_context', 'generating'] as const;

export function AISearchProgressCard({ progress }: { progress: AISearchProgress }) {
  const currentIdx = STEP_ORDER.indexOf(progress.step as typeof STEP_ORDER[number]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-purple-200 overflow-hidden">
      <div className="px-4 py-3 bg-purple-50 border-b border-purple-200 flex items-center gap-2">
        <svg className="w-4 h-4 text-purple-600 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span className="text-sm font-medium text-purple-700">AI Search in Progress</span>
      </div>

      <div className="px-4 py-4 space-y-3">
        {/* Step indicators */}
        <div className="flex items-center gap-1">
          {STEP_ORDER.map((step, i) => {
            const isDone = i < currentIdx;
            const isCurrent = step === progress.step;
            return (
              <div key={step} className="flex items-center gap-1 flex-1">
                <div className={`h-1.5 flex-1 rounded-full transition-colors ${
                  isDone ? 'bg-purple-500' : isCurrent ? 'bg-purple-300 animate-pulse' : 'bg-gray-200'
                }`} />
              </div>
            );
          })}
        </div>

        {/* Current step label + message */}
        <div>
          <p className="text-sm font-medium text-gray-900">{STEP_LABELS[progress.step] || progress.step}</p>
          <p className="text-xs text-gray-500 mt-0.5">{progress.message}</p>
        </div>
      </div>
    </div>
  );
}
