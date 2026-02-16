/**
 * Unit tests for HealthStatus component
 * 
 * Tests the health status display component that shows:
 * - Service status indicators (green=running, red=error)
 * - Recent errors
 * - Refresh button
 * 
 * Requirements: 19.5
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import HealthStatus from '../health-status';

// Mock fetch
global.fetch = jest.fn();

describe('HealthStatus Component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should display loading state initially', () => {
    (global.fetch as jest.Mock).mockImplementation(() => 
      new Promise(() => {}) // Never resolves
    );

    render(<HealthStatus />);
    expect(screen.getByText('Loading system health...')).toBeInTheDocument();
  });

  it('should display healthy system status with green indicators', async () => {
    const mockHealthData = {
      overall: 'healthy',
      services: {
        fileWatcher: { status: 'running', message: 'File watcher is running' },
        jobQueue: { status: 'running', message: 'Job queue is operational' },
        mcpServer: { status: 'running', message: 'MCP server is running' },
        database: { status: 'running', message: 'Database is connected' },
      },
      errors: [],
      timestamp: new Date().toISOString(),
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealthData,
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });

    // Check that all services are displayed
    expect(screen.getByText('File Watcher')).toBeInTheDocument();
    expect(screen.getByText('Job Queue')).toBeInTheDocument();
    expect(screen.getByText('MCP Server')).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
  });

  it('should display unhealthy system status with red indicators', async () => {
    const mockHealthData = {
      overall: 'unhealthy',
      services: {
        fileWatcher: { status: 'error', message: 'File watcher crashed' },
        jobQueue: { status: 'running', message: 'Job queue is operational' },
        mcpServer: { status: 'error', message: 'MCP server not responding' },
        database: { status: 'running', message: 'Database is connected' },
      },
      errors: [
        {
          service: 'fileWatcher',
          message: 'File watcher crashed due to permission error',
          timestamp: new Date().toISOString(),
        },
        {
          service: 'mcpServer',
          message: 'MCP server connection timeout',
          timestamp: new Date().toISOString(),
        },
      ],
      timestamp: new Date().toISOString(),
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealthData,
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Unhealthy')).toBeInTheDocument();
    });

    // Check that errors are displayed
    expect(screen.getByText('Recent Errors:')).toBeInTheDocument();
    expect(screen.getByText(/File watcher crashed due to permission error/)).toBeInTheDocument();
    expect(screen.getByText(/MCP server connection timeout/)).toBeInTheDocument();
  });

  it('should display degraded system status', async () => {
    const mockHealthData = {
      overall: 'degraded',
      services: {
        fileWatcher: { status: 'running', message: 'File watcher is running' },
        jobQueue: { status: 'running', message: 'Job queue is operational' },
        mcpServer: { status: 'stopped', message: 'MCP server is stopped' },
        database: { status: 'running', message: 'Database is connected' },
      },
      errors: [],
      timestamp: new Date().toISOString(),
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealthData,
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Degraded')).toBeInTheDocument();
    });
  });

  it('should refresh health status when refresh button is clicked', async () => {
    const mockHealthData = {
      overall: 'healthy',
      services: {
        fileWatcher: { status: 'running', message: 'File watcher is running' },
        jobQueue: { status: 'running', message: 'Job queue is operational' },
        mcpServer: { status: 'running', message: 'MCP server is running' },
        database: { status: 'running', message: 'Database is connected' },
      },
      errors: [],
      timestamp: new Date().toISOString(),
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockHealthData,
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });

    // Click refresh button
    const refreshButton = screen.getByTitle('Refresh health status');
    fireEvent.click(refreshButton);

    // Verify fetch was called again
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  it('should display error message when health check fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load system health')).toBeInTheDocument();
    });
  });

  it('should limit displayed errors to 3 most recent', async () => {
    const mockHealthData = {
      overall: 'unhealthy',
      services: {
        fileWatcher: { status: 'error', message: 'File watcher crashed' },
        jobQueue: { status: 'error', message: 'Job queue error' },
        mcpServer: { status: 'error', message: 'MCP server error' },
        database: { status: 'error', message: 'Database error' },
      },
      errors: [
        { service: 'fileWatcher', message: 'Error 1', timestamp: new Date().toISOString() },
        { service: 'jobQueue', message: 'Error 2', timestamp: new Date().toISOString() },
        { service: 'mcpServer', message: 'Error 3', timestamp: new Date().toISOString() },
        { service: 'database', message: 'Error 4', timestamp: new Date().toISOString() },
        { service: 'fileWatcher', message: 'Error 5', timestamp: new Date().toISOString() },
      ],
      timestamp: new Date().toISOString(),
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealthData,
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Recent Errors:')).toBeInTheDocument();
    });

    // Should only display first 3 errors
    expect(screen.getByText(/Error 1/)).toBeInTheDocument();
    expect(screen.getByText(/Error 2/)).toBeInTheDocument();
    expect(screen.getByText(/Error 3/)).toBeInTheDocument();
    expect(screen.queryByText(/Error 4/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Error 5/)).not.toBeInTheDocument();
  });

  it('should auto-refresh every 30 seconds', async () => {
    jest.useFakeTimers();

    const mockHealthData = {
      overall: 'healthy',
      services: {
        fileWatcher: { status: 'running', message: 'File watcher is running' },
        jobQueue: { status: 'running', message: 'Job queue is operational' },
        mcpServer: { status: 'running', message: 'MCP server is running' },
        database: { status: 'running', message: 'Database is connected' },
      },
      errors: [],
      timestamp: new Date().toISOString(),
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockHealthData,
    });

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });

    // Initial fetch
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Fast-forward 30 seconds
    jest.advanceTimersByTime(30000);

    // Should have fetched again
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    jest.useRealTimers();
  });
});
