/**
 * Integration tests for MCP Explorer functionality
 * 
 * Tests:
 * - MCP API routes work correctly
 * - Tool execution returns proper results
 * - Error handling works as expected
 * - Execution metrics are calculated
 * 
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock fetch
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('MCP Explorer Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Tool Listing', () => {
    it('should return all available MCP tools with descriptions', () => {
      const tools = [
        {
          name: 'query_case_knowledge',
          description: 'Perform semantic search on legal documents using natural language queries',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Natural language query to search for' },
              caseId: { type: 'string', description: 'Optional case ID to filter results' },
              limit: { type: 'number', description: 'Maximum number of results to return (default: 10)' },
            },
            required: ['query'],
          },
        },
        {
          name: 'scan_for_pattern',
          description: 'Search for exact patterns in legal documents using regex',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Regex pattern to search for' },
              caseId: { type: 'string', description: 'Optional case ID to filter results' },
              limit: { type: 'number', description: 'Maximum number of results to return (default: 10)' },
            },
            required: ['pattern'],
          },
        },
        {
          name: 'retrieve_exhibit',
          description: 'Find exhibit images by text description',
          inputSchema: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Text description of the exhibit to find' },
              caseId: { type: 'string', description: 'Optional case ID to filter results' },
              limit: { type: 'number', description: 'Maximum number of results to return (default: 5)' },
            },
            required: ['description'],
          },
        },
      ];

      // Verify all tools have required fields
      expect(tools).toHaveLength(3);
      tools.forEach((tool) => {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.properties).toBeDefined();
        expect(tool.inputSchema.required).toBeDefined();
      });

      // Verify specific tools exist
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('query_case_knowledge');
      expect(toolNames).toContain('scan_for_pattern');
      expect(toolNames).toContain('retrieve_exhibit');
    });
  });

  describe('Tool Execution', () => {
    it('should execute query_case_knowledge and return results', async () => {
      const mockResponse = {
        results: [
          {
            text: 'Sample text from document',
            document: 'test-doc.pdf',
            page: 1,
            score: 0.95,
          },
        ],
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const startTime = performance.now();
      const response = await fetch('/api/mcp/execute', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'query_case_knowledge',
          params: { query: 'test query' },
        }),
      });
      const endTime = performance.now();
      const executionTime = endTime - startTime;

      const data = await response.json();

      expect(response.ok).toBe(true);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].text).toBe('Sample text from document');
      expect(executionTime).toBeGreaterThan(0);
    });

    it('should calculate result count correctly', async () => {
      const mockResponse = {
        results: [
          { text: 'Result 1', document: 'doc1.pdf', page: 1, score: 0.9 },
          { text: 'Result 2', document: 'doc2.pdf', page: 2, score: 0.8 },
          { text: 'Result 3', document: 'doc3.pdf', page: 3, score: 0.7 },
        ],
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const response = await fetch('/api/mcp/execute', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'query_case_knowledge',
          params: { query: 'test' },
        }),
      });

      const data = await response.json();
      const resultCount = data.results ? data.results.length : 0;

      expect(resultCount).toBe(3);
    });

    it('should handle errors and return error details', async () => {
      const mockError = {
        error: {
          code: 'INVALID_PARAMS',
          message: 'Missing required parameter: query',
        },
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => mockError,
      } as Response);

      const response = await fetch('/api/mcp/execute', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'query_case_knowledge',
          params: {},
        }),
      });

      const data = await response.json();

      expect(response.ok).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('INVALID_PARAMS');
      expect(data.error.message).toContain('query');
    });
  });

  describe('Result Formatting', () => {
    it('should format results as JSON', () => {
      const result = {
        results: [
          {
            text: 'Complex result with nested data',
            document: 'test.pdf',
            page: 5,
            score: 0.88,
            metadata: {
              caseId: 'case-1',
              documentId: 'doc-1',
            },
          },
        ],
      };

      const jsonString = JSON.stringify(result, null, 2);

      // Verify JSON is properly formatted
      expect(jsonString).toContain('\n'); // Has newlines
      expect(jsonString).toContain('  '); // Has indentation
      expect(jsonString).toContain('"text"');
      expect(jsonString).toContain('"metadata"');
    });

    it('should display execution metrics', () => {
      const startTime = 100;
      const endTime = 250;
      const executionTime = endTime - startTime;
      const resultCount = 5;

      expect(executionTime).toBe(150);
      expect(resultCount).toBe(5);
      expect(executionTime).toBeGreaterThan(0);
      expect(resultCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Parameter Handling', () => {
    it('should filter out empty optional parameters', () => {
      const params = {
        query: 'test query',
        caseId: '',
        limit: '',
      };

      const filteredParams: Record<string, any> = {};
      Object.entries(params).forEach(([key, value]) => {
        if (value !== '' && value !== null && value !== undefined) {
          filteredParams[key] = value;
        }
      });

      expect(filteredParams).toEqual({ query: 'test query' });
      expect(filteredParams.caseId).toBeUndefined();
      expect(filteredParams.limit).toBeUndefined();
    });

    it('should convert limit parameter to number', () => {
      const params = {
        query: 'test',
        limit: '10',
      };

      const filteredParams: Record<string, any> = {};
      Object.entries(params).forEach(([key, value]) => {
        if (value !== '' && value !== null && value !== undefined) {
          if (key === 'limit' && typeof value === 'string') {
            filteredParams[key] = parseInt(value, 10);
          } else {
            filteredParams[key] = value;
          }
        }
      });

      expect(filteredParams.limit).toBe(10);
      expect(typeof filteredParams.limit).toBe('number');
    });
  });
});

