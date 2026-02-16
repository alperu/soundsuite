'use client';

interface MCPHealthIndicatorProps {
  status: 'ready' | 'degraded' | 'not_ready' | 'disabled';
  tooltip?: string;
}

const STATUS_STYLES = {
  ready:     'bg-green-500',
  degraded:  'bg-yellow-500',
  not_ready: 'bg-red-500',
  disabled:  'bg-gray-400',
};

export function MCPHealthIndicator({ status, tooltip }: MCPHealthIndicatorProps) {
  return (
    <span className="relative group inline-flex items-center">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${STATUS_STYLES[status]}`} />
      {tooltip && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-white bg-gray-900 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
          {tooltip}
        </span>
      )}
    </span>
  );
}
