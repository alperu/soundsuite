'use client';

interface DependencyInfo {
  key: string;
  label: string;
  required: boolean;
  satisfied: boolean;
}

interface MCPToolDependencyCheckerProps {
  dependencies: DependencyInfo[];
}

export function MCPToolDependencyChecker({ dependencies }: MCPToolDependencyCheckerProps) {
  if (dependencies.length === 0) {
    return <p className="text-xs text-gray-400 italic">No external dependencies</p>;
  }

  return (
    <div className="space-y-2">
      {dependencies.map((dep) => (
        <div key={dep.key} className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${dep.satisfied ? 'bg-green-500' : dep.required ? 'bg-red-500' : 'bg-yellow-500'}`} />
            <span className="text-gray-700">{dep.label}</span>
            {dep.required && <span className="text-xs text-gray-400">(required)</span>}
          </div>
          {!dep.satisfied && (
            <a href="/admin" className="text-xs text-blue-600 hover:underline">Configure</a>
          )}
        </div>
      ))}
    </div>
  );
}
