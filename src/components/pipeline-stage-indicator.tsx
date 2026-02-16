'use client';

import { VISUAL_STAGES } from '@/lib/pipeline-stages';

interface PipelineStageIndicatorProps {
  stage: string;
  detail: string;
  progress: number;
  stageIndex: number;   // 0-based raw stage index (out of 10)
  totalStages: number;  // total raw stages (10)
}

export default function PipelineStageIndicator({
  stage,
  detail,
  progress,
  stageIndex,
  totalStages,
}: PipelineStageIndicatorProps) {
  // Map raw stage index to visual stage index (0-5)
  let visualIndex = -1;
  for (let i = 0; i < VISUAL_STAGES.length; i++) {
    if ((VISUAL_STAGES[i].stages as readonly string[]).includes(stage)) {
      visualIndex = i;
      break;
    }
  }
  if (visualIndex === -1) visualIndex = 0;

  const totalVisual = VISUAL_STAGES.length;
  const overallPct = totalStages > 0 ? Math.round((stageIndex / totalStages) * 100) : 0;

  return (
    <div className="mt-2 space-y-2">
      {/* Step dots with connecting lines */}
      <div className="flex items-center justify-between px-1">
        {VISUAL_STAGES.map((vs, i) => {
          const isCompleted = i < visualIndex;
          const isCurrent = i === visualIndex;

          return (
            <div key={vs.label} className="flex items-center flex-1 last:flex-none">
              {/* Dot */}
              <div className="flex flex-col items-center">
                <div
                  className={`
                    w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold
                    ${isCompleted
                      ? 'bg-green-500 text-white'
                      : isCurrent
                        ? 'bg-yellow-400 text-yellow-900 animate-pulse'
                        : 'bg-gray-300 text-gray-500'
                    }
                  `}
                >
                  {isCompleted ? (
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span
                  className={`text-[9px] mt-0.5 leading-tight ${
                    isCompleted ? 'text-green-700' : isCurrent ? 'text-yellow-700 font-semibold' : 'text-gray-400'
                  }`}
                >
                  {vs.label}
                </span>
              </div>

              {/* Connecting line (skip last) */}
              {i < totalVisual - 1 && (
                <div
                  className={`flex-1 h-0.5 mx-1 mt-[-10px] ${
                    i < visualIndex ? 'bg-green-400' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Segmented progress bar */}
      <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden">
        {VISUAL_STAGES.map((vs, i) => {
          const isCompleted = i < visualIndex;
          const isCurrent = i === visualIndex;

          let fillPct = 0;
          if (isCompleted) fillPct = 100;
          else if (isCurrent) fillPct = Math.max(10, Math.min(90, progress));

          return (
            <div
              key={vs.label}
              className="flex-1 bg-gray-200 rounded-sm overflow-hidden"
            >
              <div
                className={`h-full transition-all duration-500 ease-out rounded-sm ${
                  isCompleted ? 'bg-green-500' : isCurrent ? 'bg-yellow-400' : ''
                }`}
                style={{ width: `${fillPct}%` }}
              />
            </div>
          );
        })}
      </div>

      {/* Text info line */}
      <div className="text-[10px] text-yellow-700 flex items-center justify-between">
        <span className="truncate mr-2">{detail}</span>
        <span className="whitespace-nowrap text-yellow-600">
          {stageIndex + 1}/{totalStages} | {overallPct}%
        </span>
      </div>
    </div>
  );
}
