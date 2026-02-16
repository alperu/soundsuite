'use client';

import { useState } from 'react';

interface ServerConnectionProps {
  serverUrl: string | null;
  wsConnected: boolean;
  onConnect: (url: string) => void;
  onDisconnect: () => void;
}

export default function ServerConnection({
  serverUrl,
  wsConnected,
  onConnect,
  onDisconnect,
}: ServerConnectionProps) {
  const [url, setUrl] = useState(serverUrl ?? '');

  // Keep input in sync when serverUrl prop changes (e.g. after first status poll)
  const [lastServerUrl, setLastServerUrl] = useState(serverUrl);
  if (serverUrl && serverUrl !== lastServerUrl) {
    setUrl(serverUrl);
    setLastServerUrl(serverUrl);
  }

  const displayUrl = url || serverUrl || '';

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm mb-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-4">Server Connection</h2>

      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          value={displayUrl}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://your-server-ip:3000"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        {wsConnected ? (
          <button
            onClick={onDisconnect}
            className="bg-red-500 hover:bg-red-600 text-white rounded-md px-4 py-2 text-sm font-medium"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={() => onConnect(displayUrl)}
            className="bg-blue-500 hover:bg-blue-600 text-white rounded-md px-4 py-2 text-sm font-medium"
          >
            Connect
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            wsConnected ? 'bg-green-500' : 'bg-red-500'
          }`}
        />
        <span className="text-sm text-slate-600">
          {wsConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        WebSocket relay connects on port 3002 of the server URL.
      </p>
    </div>
  );
}
