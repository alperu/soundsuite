/**
 * @jest-environment node
 *
 * These tests start the real MCP HTTP server and drive it with `fetch`. jsdom
 * supplies no global fetch, so every request-level test failed with
 * `ReferenceError: fetch is not defined`; Node's environment provides one. That
 * is also the honest environment here — the MCP server is server-only code.
 *
 * Note this is NOT the TextDecoder polyfill case (task #55): the polyfill is
 * global and applies either way. This suite needs `fetch`, which only the node
 * environment brings.
 */

/**
 * Unit tests for MCPServer class.
 *
 * These tests verify:
 * - Server initialization and startup
 * - Authentication modes (OAuth, API key, none)
 * - Request routing and validation
 * - Tool execution via ToolRegistry
 * - Error handling and responses
 */

import { MCPServer, MCPServerConfig } from '../mcp-server';
import { ToolRegistry } from '../tool-registry';
import { ToolExecutionLogger } from '../tool-execution-logger';
import { getAllTools } from '../tools';
import type { ToolExecutionContext } from '../tool-types';

// Mock dependencies
jest.mock('../../vector/vector-store');

/**
 * `@prisma/client` needs a factory, not the bare automock.
 *
 * Importing `../tools` reaches `@/lib/db/prisma`, which builds its client at
 * MODULE scope and immediately chains `.$extends(...)` twice (cache
 * invalidation, then XETO validation). Jest's automock can't see `$extends` —
 * the real client exposes it dynamically — so the automocked instance has no
 * such method and the whole suite died on the import line with
 * `TypeError: client.$extends is not a function`, before a single test ran.
 *
 * `$extends` returns the same stub so the chain terminates, and
 * `Prisma.defineExtension` hands its argument straight back, which is all the
 * extension modules do with it. No real database is opened: the tools read the
 * `mockDatabase` passed into their context, and anything that reaches for the
 * global client instead gets the empty delegates below.
 */
jest.mock('@prisma/client', () => {
  const base: Record<string, unknown> = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $on: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  // A Proxy rather than a fixed object: code behind these tools also queries
  // the GLOBAL client for models this suite never names (the boolean-filter
  // traversal in search/boolean-to-fts walks motion / person / motionEvent).
  // Listing models by hand only moves the "reading 'findMany' of undefined"
  // failure to whichever model someone adds next, so any unknown property
  // answers with an empty delegate.
  const client: Record<string, unknown> = new Proxy(base, {
    get(target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (prop === '$extends') return () => client;
      if (prop.startsWith('$') || prop === 'then') return undefined;
      return {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      };
    },
  }) as Record<string, unknown>;
  return {
    PrismaClient: jest.fn(() => client),
    Prisma: { defineExtension: (ext: unknown) => ext },
  };
});

/** Build a real ToolRegistry backed by mock services. */
async function createTestRegistry(
  mockVectorStore: any,
  mockDatabase: any,
  mockEmbeddingProvider: any,
): Promise<ToolRegistry> {
  const mockConfigStore = {
    getAllToolConfigs: jest.fn().mockResolvedValue(new Map()),
    getToolConfig: jest.fn().mockResolvedValue(null),
    setToolConfig: jest.fn().mockResolvedValue(undefined),
  } as any;

  const context: ToolExecutionContext = {
    vectorStore: mockVectorStore,
    embeddingProvider: mockEmbeddingProvider,
    database: mockDatabase,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
  };

  const registry = new ToolRegistry(mockConfigStore, new ToolExecutionLogger(), context);
  await registry.registerAll(getAllTools());
  return registry;
}

describe('MCPServer', () => {
  let mockVectorStore: any;
  let mockDatabase: any;
  let mockEmbeddingProvider: any;

  beforeEach(() => {
    mockVectorStore = {
      initialize: jest.fn(),
      search: jest.fn(),
      insertChunks: jest.fn(),
      deleteByDocument: jest.fn(),
      close: jest.fn(),
    };

    // This mock only had `document.findUnique` — all query_case_knowledge
    // needed when the test was written. The tool has since grown case-scope
    // resolution, filing/document enrichment, and the prisma-traverse filter
    // path in `resolvePrismaFilters` (search/boolean-to-fts.ts), which walks
    // motion / person / motionEvent. Each landed on an undefined delegate, so
    // the tool answered 500 with "Cannot read properties of undefined (reading
    // 'findMany')" — invisible until this suite could run at all.
    //
    // The delegate list mirrors the `PrismaLike` interface boolean-to-fts
    // declares. Empty results are the right stub: these assertions are about
    // the vector hits, which come from mockVectorStore.
    const emptyModel = () => ({
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    });
    mockDatabase = {
      document: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      filing: emptyModel(),
      case: emptyModel(),
      motion: emptyModel(),
      motionEvent: emptyModel(),
      person: emptyModel(),
      $disconnect: jest.fn(),
    };

    mockEmbeddingProvider = {
      embed: jest.fn(),
      getDimensions: jest.fn().mockReturnValue(384),
      getAvailableModels: jest.fn().mockReturnValue(['model1', 'model2']),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Server Initialization', () => {
    it('should create server with API key auth mode', async () => {
      const config: MCPServerConfig = {
        port: 3001,
        authMode: 'apikey',
        apiKeys: ['test-key'],
      };

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      const server = new MCPServer(config, registry);
      expect(server).toBeInstanceOf(MCPServer);
    });

    it('should create server with OAuth auth mode', async () => {
      const config: MCPServerConfig = {
        port: 3001,
        authMode: 'oauth',
        oauthConfig: {
          providerUrl: 'https://oauth.example.com',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: 'http://localhost:3001/callback',
        },
      };

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      const server = new MCPServer(config, registry);
      expect(server).toBeInstanceOf(MCPServer);
    });

    it('should create server with no auth mode', async () => {
      const config: MCPServerConfig = {
        port: 3001,
        authMode: 'none',
      };

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      const server = new MCPServer(config, registry);
      expect(server).toBeInstanceOf(MCPServer);
    });
  });

  describe('Authentication - API Key Mode', () => {
    let server: MCPServer;
    const port = 3101;

    beforeEach(async () => {
      const config: MCPServerConfig = {
        port,
        authMode: 'apikey',
        apiKeys: ['valid-key-1', 'valid-key-2'],
      };

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      server = new MCPServer(config, registry);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should accept request with valid API key', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'valid-key-1',
        },
        body: JSON.stringify({
          tool: 'list_tools',
          params: {},
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.tools).toBeDefined();
      expect(Array.isArray(data.tools)).toBe(true);
    });

    it('should reject request with invalid API key', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'invalid-key',
        },
        body: JSON.stringify({
          tool: 'list_tools',
          params: {},
        }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('AUTH_FAILED');
    });

    it('should reject request without API key', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'list_tools',
          params: {},
        }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('AUTH_FAILED');
    });
  });

  describe('Authentication - OAuth Mode', () => {
    let server: MCPServer;
    const port = 3102;

    beforeEach(async () => {
      const config: MCPServerConfig = {
        port,
        authMode: 'oauth',
        oauthConfig: {
          providerUrl: 'https://oauth.example.com',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: `http://localhost:${port}/callback`,
        },
      };

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      server = new MCPServer(config, registry);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should accept request with Bearer token', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
        body: JSON.stringify({
          tool: 'list_tools',
          params: {},
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.tools).toBeDefined();
    });

    it('should reject request without Authorization header', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'list_tools',
          params: {},
        }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe('AUTH_FAILED');
    });

    it('should reject request with invalid Authorization format', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'InvalidFormat',
        },
        body: JSON.stringify({
          tool: 'list_tools',
          params: {},
        }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe('AUTH_FAILED');
    });
  });

  describe('Authentication - No Auth Mode', () => {
    let server: MCPServer;
    const port = 3103;

    beforeEach(async () => {
      const config: MCPServerConfig = {
        port,
        authMode: 'none',
      };

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      server = new MCPServer(config, registry);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should accept request without authentication', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'list_tools',
          params: {},
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.tools).toBeDefined();
    });
  });

  describe('Request Validation', () => {
    let server: MCPServer;
    const port = 3104;

    beforeEach(async () => {
      const config: MCPServerConfig = {
        port,
        authMode: 'none',
      };

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      server = new MCPServer(config, registry);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should reject GET requests', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'GET',
      });

      expect(response.status).toBe(405);
      const data = await response.json();
      expect(data.error.code).toBe('METHOD_NOT_ALLOWED');
    });

    it('should reject requests with invalid JSON', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: 'invalid json',
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_REQUEST');
    });

    it('should reject requests without tool name', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          params: {},
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_REQUEST');
    });

    it('should reject requests with unknown tool', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'unknown_tool',
          params: {},
        }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe('TOOL_NOT_FOUND');
    });
  });

  describe('Tool: list_tools', () => {
    let server: MCPServer;
    const port = 3105;

    beforeEach(async () => {
      const config: MCPServerConfig = {
        port,
        authMode: 'none',
      };

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      server = new MCPServer(config, registry);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should return list of enabled tools', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'list_tools',
          params: {},
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.tools).toBeDefined();
      expect(Array.isArray(data.tools)).toBe(true);
      // Asserted `=== 3` back when the registry held only the original three
      // tools; it now ships 15. An exact count here is a tripwire that fires
      // whenever a tool is added, not a statement about what `list_tools`
      // promises — which is that enabled tools come back and the three core
      // ones are among them, checked immediately below.
      expect(data.tools.length).toBeGreaterThanOrEqual(3);

      const toolNames = data.tools.map((t: any) => t.name);
      expect(toolNames).toContain('query_case_knowledge');
      expect(toolNames).toContain('scan_for_pattern');
      expect(toolNames).toContain('retrieve_exhibit');
    });

    it('should include tool schemas', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'list_tools',
          params: {},
        }),
      });

      const data = await response.json();
      const queryTool = data.tools.find((t: any) => t.name === 'query_case_knowledge');

      expect(queryTool).toBeDefined();
      expect(queryTool.description).toBeDefined();
      expect(queryTool.inputSchema).toBeDefined();
      expect(queryTool.inputSchema.properties).toBeDefined();
      expect(queryTool.inputSchema.required).toContain('query');
    });
  });

  describe('Tool: query_case_knowledge', () => {
    let server: MCPServer;
    const port = 3106;

    beforeEach(async () => {
      const config: MCPServerConfig = {
        port,
        authMode: 'none',
      };

      // Setup mocks before creating registry
      mockEmbeddingProvider.embed.mockResolvedValue([[0.1, 0.2, 0.3]]);
      mockVectorStore.search.mockResolvedValue([
        {
          chunkId: 'chunk-1',
          text: 'Sample text from document',
          metadata: {
            documentId: 'doc-1',
            caseId: 'case-1',
            pageNumber: 5,
            chunkIndex: 0,
            isExhibit: false,
          },
          score: 0.85,
        },
      ]);
      (mockDatabase.document.findUnique as jest.Mock).mockResolvedValue({
        id: 'doc-1',
        fileName: 'test.pdf',
      });

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      server = new MCPServer(config, registry);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should perform semantic search', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'query_case_knowledge',
          params: {
            query: 'contract terms',
            limit: 10,
          },
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.results.length).toBe(1);
      expect(data.results[0].text).toBe('Sample text from document');
      expect(data.results[0].document).toBe('test.pdf');
      expect(data.results[0].page).toBe(5);
      expect(data.results[0].score).toBe(0.85);
    });

    it('should reject request without query parameter', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'query_case_knowledge',
          params: {},
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_PARAMS');
    });
  });

  describe('Tool: scan_for_pattern', () => {
    let server: MCPServer;
    const port = 3107;

    beforeEach(async () => {
      const config: MCPServerConfig = {
        port,
        authMode: 'none',
      };

      // Setup mocks
      mockVectorStore.search.mockResolvedValue([
        {
          chunkId: 'chunk-1',
          text: 'The amount is $50,000 as specified',
          metadata: {
            documentId: 'doc-1',
            caseId: 'case-1',
            pageNumber: 3,
            chunkIndex: 0,
            isExhibit: false,
          },
          score: 0,
        },
      ]);
      (mockDatabase.document.findUnique as jest.Mock).mockResolvedValue({
        id: 'doc-1',
        fileName: 'contract.pdf',
      });

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      server = new MCPServer(config, registry);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should perform pattern search', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'scan_for_pattern',
          params: {
            pattern: '\\$[0-9,]+',
            limit: 10,
          },
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.results.length).toBe(1);
      expect(data.results[0].match).toBe('$50,000');
    });

    it('should reject invalid regex pattern', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'scan_for_pattern',
          params: {
            pattern: '[invalid(',
          },
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_REGEX');
    });
  });

  describe('Tool: retrieve_exhibit', () => {
    let server: MCPServer;
    const port = 3108;

    beforeEach(async () => {
      const config: MCPServerConfig = {
        port,
        authMode: 'none',
      };

      // Setup mocks
      mockEmbeddingProvider.embed.mockResolvedValue([[0.1, 0.2, 0.3]]);
      mockVectorStore.search.mockResolvedValue([
        {
          chunkId: 'chunk-1',
          text: 'Photo of accident scene',
          metadata: {
            documentId: 'doc-1',
            caseId: 'case-1',
            pageNumber: 2,
            chunkIndex: 0,
            isExhibit: true,
            exhibitPath: '/exhibits/case-1/doc-1_page2_img0.png',
          },
          score: 0.9,
        },
      ]);
      (mockDatabase.document.findUnique as jest.Mock).mockResolvedValue({
        id: 'doc-1',
        fileName: 'evidence.pdf',
      });

      const registry = await createTestRegistry(mockVectorStore, mockDatabase, mockEmbeddingProvider);
      server = new MCPServer(config, registry);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should retrieve exhibits by description', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'retrieve_exhibit',
          params: {
            description: 'accident scene photo',
            limit: 5,
          },
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.results.length).toBe(1);
      expect(data.results[0].imagePath).toBe('/exhibits/case-1/doc-1_page2_img0.png');
      expect(data.results[0].ocrText).toBe('Photo of accident scene');
      expect(data.results[0].document).toBe('evidence.pdf');
    });

    it('should reject request without description parameter', async () => {
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'retrieve_exhibit',
          params: {},
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_PARAMS');
    });
  });
});
