'use client';

interface ModeSelectorProps {
  currentMode: string;
  onModeChange: (mode: string) => void;
}

export default function ModeSelector({ currentMode, onModeChange }: ModeSelectorProps) {
  const modes = [
    { value: 'indexing', label: 'Indexing (Embed+OCR)' },
    { value: 'searching', label: 'Searching (Embed+Completion+Reranker)' },
  ];

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm mb-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-2">Mode</h2>
      <p className="text-sm text-slate-500 mb-4">
        Single-GPU machines share VRAM across roles. Switch modes to re-allocate containers.
      </p>

      <div className="flex gap-3">
        {modes.map((mode) => {
          const isActive = currentMode === mode.value;
          return (
            <button
              key={mode.value}
              onClick={() => onModeChange(mode.value)}
              className={`rounded-md px-4 py-2 text-sm font-medium border-2 transition-colors ${
                isActive
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
