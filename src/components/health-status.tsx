'use client';

import React, { useState, useEffect } from 'react';

interface ServiceHealth {
  status: 'running' | 'error' | 'stopped';
  message: string;
  details?: Record<string, any>;
}

interface SystemHealth {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  fileWatcher?: ServiceHealth;
  jobQueue?: ServiceHealth;
  mcpServer?: ServiceHealth;
  database?: ServiceHealth;
  services?: {
    fileWatcher: ServiceHealth;
    jobQueue: ServiceHealth;
    mcpServer: ServiceHealth;
    database: ServiceHealth;
  };
  errors?: Array<{
    service: string;
    message: string;
    timestamp: string;
  }>;
  timestamp: string;
}

// Simple refresh icon component
function RefreshIcon({ className = '', spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg
      className={`${className} ${spinning ? 'animate-spin' : ''}`}
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
    </svg>
  );
}

export default function HealthStatus() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchHealth = async () => {
    try {
      const response = await fetch('/api/health');
      const data = await response.json();
      setHealth(data);
    } catch (error) {
      console.error('Failed to fetch health status:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchHealth();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchHealth();
  };

  const getStatusColor = (status: 'running' | 'error' | 'stopped') => {
    switch (status) {
      case 'running':
        return 'bg-green-500';
      case 'error':
        return 'bg-red-500';
      case 'stopped':
        return 'bg-gray-400';
      default:
        return 'bg-gray-400';
    }
  };

  const getOverallStatusColor = (overall: 'healthy' | 'degraded' | 'unhealthy') => {
    switch (overall) {
      case 'healthy':
        return 'text-green-600';
      case 'degraded':
        return 'text-yellow-600';
      case 'unhealthy':
        return 'text-red-600';
      default:
        return 'text-gray-600';
    }
  };

  if (loading) {
    return (
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-500">Loading system health...</div>
        </div>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="text-sm text-red-600">Failed to load system health</div>
          <button
            onClick={handleRefresh}
            className="p-1 hover:bg-gray-100 rounded"
            title="Refresh"
          >
            <RefreshIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border-b border-gray-200 px-6 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-6">
          {/* Overall Status */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">System:</span>
            <span className={`text-sm font-semibold ${getOverallStatusColor(health.overall)}`}>
              {health.overall.charAt(0).toUpperCase() + health.overall.slice(1)}
            </span>
          </div>

          {/* Service Indicators */}
          <div className="flex items-center gap-4">
            {Object.entries(health.services ?? { fileWatcher: health.fileWatcher, jobQueue: health.jobQueue, mcpServer: health.mcpServer, database: health.database })
              .filter(([, service]) => service != null)
              .map(([serviceName, service]) => (
              <div key={serviceName} className="flex items-center gap-2" title={service!.message}>
                <div className={`w-2 h-2 rounded-full ${getStatusColor(service!.status)}`} />
                <span className="text-sm text-gray-600">
                  {serviceName === 'fileWatcher' && 'File Watcher'}
                  {serviceName === 'jobQueue' && 'Job Queue'}
                  {serviceName === 'mcpServer' && 'MCP Server'}
                  {serviceName === 'database' && 'Database'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Refresh Button */}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-1 hover:bg-gray-100 rounded disabled:opacity-50"
          title="Refresh health status"
        >
          <RefreshIcon className="w-4 h-4" spinning={refreshing} />
        </button>
      </div>

      {/* Recent Errors */}
      {health.errors?.length ? (
        <div className="mt-3 pt-3 border-t border-gray-200">
          <div className="text-xs font-medium text-gray-700 mb-2">Recent Errors:</div>
          <div className="space-y-1">
            {health.errors.slice(0, 3).map((error, index) => (
              <div key={index} className="flex items-start gap-2 text-xs">
                <span className="text-red-600 font-medium">{error.service}:</span>
                <span className="text-gray-600 flex-1">{error.message}</span>
                <span className="text-gray-400">
                  {new Date(error.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
