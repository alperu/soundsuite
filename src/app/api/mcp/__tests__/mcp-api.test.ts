/**
 * Unit tests for MCP API routes
 * 
 * Tests:
 * - Execute MCP tools via API
 * - List available MCP tools
 * - Handle authentication
 * - Handle errors
 * - Proxy requests to MCP server
 * 
 * Requirements: 16.2, 16.3, 16.4, 16.5
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('MCP API Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment variables
    delete process.env.MCP_SERVER_URL;
    delete process.env.MCP_API_KEY;
  });

  describe('POST /api/mcp/execute', () => {
    it('should execute MCP tool and return results', async () => {
      const mockResponse = {
        results: [
          {
            text: 'Sample result',
            document: 'test.pdf',
            page: 1,
            score: 0.9,
          },
        ],
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const { POST } = await import('../execute/route');
      const request = new Request('http://localhost:3000/api/mcp/execute', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'query_case_knowledge',
          params: { query: 'test query' },
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].text).toBe('Sample result');
    });

    it('should return error for missing tool name', async () => {
      const { POST } = await import('../execute/route');
      const request = new Request('http://localhost:3000/api/mcp/execute', {
        method: 'POST',
        body: JSON.stringify({
          params: { query: 'test' },
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toContain('tool name');
    });

    it('should forward API key to MCP server', async () => {
      process.env.MCP_API_KEY = 'test-api-key';

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      } as Response);

      const { POST } = await import('../execute/route');
      const request = new Request('http://localhost:3000/api/mcp/execute', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'query_case_knowledge',
          params: { query: 'test' },
        }),
      });

      await POST(request);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'test-api-key',
          }),
        })
      );
    });

    it('should use default MCP server URL if not configured', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      } as Response);

      const { POST } = await import('../execute/route');
      const request = new Request('http://localhost:3000/api/mcp/execute', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'query_case_knowledge',
          params: { query: 'test' },
        }),
      });

      await POST(request);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001',
        expect.any(Object)
      );
    });

    it('should handle MCP server errors', async () => {
      const mockError = {
        error: {
          code: 'INVALID_REGEX',
          message: 'Invalid regex pattern',
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => mockError,
      } as Response);

      const { POST } = await import('../execute/route');
      const request = new Request('http://localhost:3000/api/mcp/execute', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'scan_for_pattern',
          params: { pattern: '[invalid' },
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe('INVALID_REGEX');
    });

    it('should handle network errors', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(
        new Error('Network error')
      );

      const { POST } = await import('../execute/route');
      const request = new Request('http://localhost:3000/api/mcp/execute', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'query_case_knowledge',
          params: { query: 'test' },
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error.code).toBe('EXECUTION_FAILED');
      expect(data.error.message).toContain('Network error');
    });
  });

  describe('GET /api/mcp/tools', () => {
    it('should list available MCP tools', async () => {
      const mockTools = {
        tools: [
          {
            name: 'query_case_knowledge',
            description: 'Semantic search',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
          {
            name: 'scan_for_pattern',
            description: 'Pattern search',
            inputSchema: {
              type: 'object',
              properties: { pattern: { type: 'string' } },
              required: ['pattern'],
            },
          },
        ],
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockTools,
      } as Response);

      const { GET } = await import('../tools/route');
      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.tools).toHaveLength(2);
      expect(data.tools[0].name).toBe('query_case_knowledge');
      expect(data.tools[1].name).toBe('scan_for_pattern');
    });

    it('should handle MCP server unavailable', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(
        new Error('Connection refused')
      );

      const { GET } = await import('../tools/route');
      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error.code).toBe('FETCH_FAILED');
    });

    it('should use configured MCP server URL', async () => {
      process.env.MCP_SERVER_URL = 'http://custom-server:4000';

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tools: [] }),
      } as Response);

      const { GET } = await import('../tools/route');
      await GET();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://custom-server:4000',
        expect.any(Object)
      );
    });
  });
});
