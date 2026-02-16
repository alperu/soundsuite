/**
 * End-to-end test script for MCP Server.
 *
 * This script performs comprehensive testing of the MCP server including:
 * - Authentication (OAuth, API key, none)
 * - All three MCP tools (query_case_knowledge, scan_for_pattern, retrieve_exhibit)
 * - Error handling and edge cases
 * - Structured response validation
 *
 * Run with: npx ts-node src/lib/mcp/e2e-test-mcp-server.ts
 */

import { MCPServer, MCPServerConfig } from './mcp-server';
import { ToolRegistry } from './tool-registry';
import { ToolConfigStore } from './tool-config-store';
import { ToolExecutionLogger } from './tool-execution-logger';
import { ToolExecutionContext } from './tool-types';
import { getAllTools } from './tools';
import { VectorStore } from '../vector/vector-store';
import { PrismaClient } from '@prisma/client';
import { TransformersEmbeddingProvider } from '../ingestion/transformers-embedding-provider';
import { createLogger } from '../logger';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
}

const results: TestResult[] = [];

function logTest(name: string, passed: boolean, message: string) {
  results.push({ name, passed, message });
  const icon = passed ? '✓' : '✗';
  const color = passed ? '\x1b[32m' : '\x1b[31m';
  console.log(`${color}${icon}\x1b[0m ${name}: ${message}`);
}

async function createRegistry(vectorStore: VectorStore, prisma: PrismaClient, embeddingProvider: TransformersEmbeddingProvider): Promise<ToolRegistry> {
  const configStore = new ToolConfigStore();
  const executionLogger = new ToolExecutionLogger();
  const context: ToolExecutionContext = {
    vectorStore,
    embeddingProvider,
    database: prisma,
    logger: createLogger('MCPTools'),
  };
  const registry = new ToolRegistry(configStore, executionLogger, context);
  await registry.registerAll(getAllTools());
  return registry;
}

async function testAuthentication() {
  console.log('\n=== Testing Authentication ===\n');

  // Test 1: API Key Authentication - Valid Key
  console.log('1. API Key Authentication - Valid Key');
  const apiKeyConfig: MCPServerConfig = {
    port: 3201,
    authMode: 'apikey',
    apiKeys: ['test-key-123', 'test-key-456'],
  };

  const prisma = new PrismaClient();
  const vectorStore = new VectorStore({
    dbPath: './data/lancedb-test',
    tableName: 'chunks',
  });
  await vectorStore.initialize();

  const embeddingProvider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');

  const registry1 = await createRegistry(vectorStore, prisma, embeddingProvider);
  const apiKeyServer = new MCPServer(apiKeyConfig, registry1);

  await apiKeyServer.start();

  try {
    const response = await fetch('http://localhost:3201', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-key-123',
      },
      body: JSON.stringify({
        tool: 'list_tools',
        params: {},
      }),
    });

    if (response.ok) {
      const data = await response.json();
      logTest(
        'API Key - Valid',
        data.tools && data.tools.length >= 3,
        `Accepted valid API key, returned ${data.tools?.length || 0} tools`
      );
    } else {
      logTest('API Key - Valid', false, `Expected 200, got ${response.status}`);
    }
  } catch (error) {
    logTest('API Key - Valid', false, error instanceof Error ? error.message : String(error));
  }

  // Test 2: API Key Authentication - Invalid Key
  console.log('2. API Key Authentication - Invalid Key');
  try {
    const response = await fetch('http://localhost:3201', {
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

    const data = await response.json();
    logTest(
      'API Key - Invalid',
      response.status === 401 && data.error?.code === 'AUTH_FAILED',
      `Rejected invalid API key with 401 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('API Key - Invalid', false, error instanceof Error ? error.message : String(error));
  }

  // Test 3: API Key Authentication - Missing Key
  console.log('3. API Key Authentication - Missing Key');
  try {
    const response = await fetch('http://localhost:3201', {
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
    logTest(
      'API Key - Missing',
      response.status === 401 && data.error?.code === 'AUTH_FAILED',
      `Rejected missing API key with 401 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('API Key - Missing', false, error instanceof Error ? error.message : String(error));
  }

  await apiKeyServer.stop();

  // Test 4: OAuth Authentication - Valid Token
  console.log('4. OAuth Authentication - Valid Token');
  const oauthConfig: MCPServerConfig = {
    port: 3202,
    authMode: 'oauth',
    oauthConfig: {
      providerUrl: 'https://oauth.example.com',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:3202/callback',
    },
  };

  const registry2 = await createRegistry(vectorStore, prisma, embeddingProvider);
  const oauthServer = new MCPServer(oauthConfig, registry2);

  await oauthServer.start();

  try {
    const response = await fetch('http://localhost:3202', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token-123',
      },
      body: JSON.stringify({
        tool: 'list_tools',
        params: {},
      }),
    });

    if (response.ok) {
      const data = await response.json();
      logTest(
        'OAuth - Valid Token',
        data.tools && data.tools.length >= 3,
        `Accepted Bearer token, returned ${data.tools?.length || 0} tools`
      );
    } else {
      logTest('OAuth - Valid Token', false, `Expected 200, got ${response.status}`);
    }
  } catch (error) {
    logTest('OAuth - Valid Token', false, error instanceof Error ? error.message : String(error));
  }

  // Test 5: OAuth Authentication - Missing Token
  console.log('5. OAuth Authentication - Missing Token');
  try {
    const response = await fetch('http://localhost:3202', {
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
    logTest(
      'OAuth - Missing Token',
      response.status === 401 && data.error?.code === 'AUTH_FAILED',
      `Rejected missing token with 401 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('OAuth - Missing Token', false, error instanceof Error ? error.message : String(error));
  }

  // Test 6: OAuth Authentication - Invalid Format
  console.log('6. OAuth Authentication - Invalid Format');
  try {
    const response = await fetch('http://localhost:3202', {
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

    const data = await response.json();
    logTest(
      'OAuth - Invalid Format',
      response.status === 401 && data.error?.code === 'AUTH_FAILED',
      `Rejected invalid format with 401 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('OAuth - Invalid Format', false, error instanceof Error ? error.message : String(error));
  }

  await oauthServer.stop();

  // Test 7: No Authentication Mode
  console.log('7. No Authentication Mode');
  const noAuthConfig: MCPServerConfig = {
    port: 3203,
    authMode: 'none',
  };

  const registry3 = await createRegistry(vectorStore, prisma, embeddingProvider);
  const noAuthServer = new MCPServer(noAuthConfig, registry3);

  await noAuthServer.start();

  try {
    const response = await fetch('http://localhost:3203', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'list_tools',
        params: {},
      }),
    });

    if (response.ok) {
      const data = await response.json();
      logTest(
        'No Auth Mode',
        data.tools && data.tools.length >= 3,
        `Accepted request without auth, returned ${data.tools?.length || 0} tools`
      );
    } else {
      logTest('No Auth Mode', false, `Expected 200, got ${response.status}`);
    }
  } catch (error) {
    logTest('No Auth Mode', false, error instanceof Error ? error.message : String(error));
  }

  await noAuthServer.stop();
  await vectorStore.close();
  await prisma.$disconnect();
}

async function testMCPTools() {
  console.log('\n=== Testing MCP Tools ===\n');

  const prisma = new PrismaClient();
  const vectorStore = new VectorStore({
    dbPath: './data/lancedb-test',
    tableName: 'chunks',
  });
  await vectorStore.initialize();

  const embeddingProvider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');

  const config: MCPServerConfig = {
    port: 3204,
    authMode: 'none',
  };

  const registry = await createRegistry(vectorStore, prisma, embeddingProvider);
  const server = new MCPServer(config, registry);

  await server.start();

  // Test 8: list_tools
  console.log('8. list_tools - Get available tools');
  try {
    const response = await fetch('http://localhost:3204', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'list_tools',
        params: {},
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const hasAllTools = data.tools &&
        data.tools.some((t: any) => t.name === 'query_case_knowledge') &&
        data.tools.some((t: any) => t.name === 'scan_for_pattern') &&
        data.tools.some((t: any) => t.name === 'retrieve_exhibit');

      logTest(
        'list_tools',
        hasAllTools,
        `Returned ${data.tools?.length || 0} tools with schemas`
      );
    } else {
      logTest('list_tools', false, `Expected 200, got ${response.status}`);
    }
  } catch (error) {
    logTest('list_tools', false, error instanceof Error ? error.message : String(error));
  }

  // Test 9: query_case_knowledge - Valid Query
  console.log('9. query_case_knowledge - Valid Query');
  try {
    const response = await fetch('http://localhost:3204', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'query_case_knowledge',
        params: {
          query: 'contract terms and conditions',
          limit: 5,
        },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const hasResults = data.results && Array.isArray(data.results);
      logTest(
        'query_case_knowledge - Valid',
        hasResults,
        `Returned ${data.results?.length || 0} results`
      );
    } else {
      const data = await response.json();
      logTest('query_case_knowledge - Valid', false, `Expected 200, got ${response.status}: ${data.error?.message}`);
    }
  } catch (error) {
    logTest('query_case_knowledge - Valid', false, error instanceof Error ? error.message : String(error));
  }

  // Test 10: query_case_knowledge - Missing Query Parameter
  console.log('10. query_case_knowledge - Missing Query Parameter');
  try {
    const response = await fetch('http://localhost:3204', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'query_case_knowledge',
        params: {},
      }),
    });

    const data = await response.json();
    logTest(
      'query_case_knowledge - Missing Param',
      response.status === 400 && data.error?.code === 'INVALID_PARAMS',
      `Rejected missing query with 400 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('query_case_knowledge - Missing Param', false, error instanceof Error ? error.message : String(error));
  }

  // Test 11: query_case_knowledge - With Case Filter
  console.log('11. query_case_knowledge - With Case Filter');
  try {
    const response = await fetch('http://localhost:3204', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'query_case_knowledge',
        params: {
          query: 'evidence',
          caseId: 'test-case-id',
          limit: 3,
        },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      logTest(
        'query_case_knowledge - Case Filter',
        data.results && Array.isArray(data.results),
        `Returned ${data.results?.length || 0} results with case filter`
      );
    } else {
      const data = await response.json();
      logTest('query_case_knowledge - Case Filter', false, `Expected 200, got ${response.status}: ${data.error?.message}`);
    }
  } catch (error) {
    logTest('query_case_knowledge - Case Filter', false, error instanceof Error ? error.message : String(error));
  }

  // Test 12: scan_for_pattern - Valid Pattern
  console.log('12. scan_for_pattern - Valid Pattern');
  try {
    const response = await fetch('http://localhost:3204', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'scan_for_pattern',
        params: {
          pattern: '\\$[0-9,]+',
          limit: 5,
        },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      logTest(
        'scan_for_pattern - Valid',
        data.results && Array.isArray(data.results),
        `Returned ${data.results?.length || 0} results`
      );
    } else {
      const data = await response.json();
      logTest('scan_for_pattern - Valid', false, `Expected 200, got ${response.status}: ${data.error?.message}`);
    }
  } catch (error) {
    logTest('scan_for_pattern - Valid', false, error instanceof Error ? error.message : String(error));
  }

  // Test 13: scan_for_pattern - Invalid Regex
  console.log('13. scan_for_pattern - Invalid Regex');
  try {
    const response = await fetch('http://localhost:3204', {
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

    const data = await response.json();
    logTest(
      'scan_for_pattern - Invalid Regex',
      response.status === 400 && data.error?.code === 'INVALID_REGEX',
      `Rejected invalid regex with 400 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('scan_for_pattern - Invalid Regex', false, error instanceof Error ? error.message : String(error));
  }

  // Test 14: scan_for_pattern - Missing Pattern Parameter
  console.log('14. scan_for_pattern - Missing Pattern Parameter');
  try {
    const response = await fetch('http://localhost:3204', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'scan_for_pattern',
        params: {},
      }),
    });

    const data = await response.json();
    logTest(
      'scan_for_pattern - Missing Param',
      response.status === 400 && data.error?.code === 'INVALID_PARAMS',
      `Rejected missing pattern with 400 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('scan_for_pattern - Missing Param', false, error instanceof Error ? error.message : String(error));
  }

  // Test 15: retrieve_exhibit - Valid Description
  console.log('15. retrieve_exhibit - Valid Description');
  try {
    const response = await fetch('http://localhost:3204', {
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

    if (response.ok) {
      const data = await response.json();
      logTest(
        'retrieve_exhibit - Valid',
        data.results && Array.isArray(data.results),
        `Returned ${data.results?.length || 0} results`
      );
    } else {
      const data = await response.json();
      logTest('retrieve_exhibit - Valid', false, `Expected 200, got ${response.status}: ${data.error?.message}`);
    }
  } catch (error) {
    logTest('retrieve_exhibit - Valid', false, error instanceof Error ? error.message : String(error));
  }

  // Test 16: retrieve_exhibit - Missing Description Parameter
  console.log('16. retrieve_exhibit - Missing Description Parameter');
  try {
    const response = await fetch('http://localhost:3204', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'retrieve_exhibit',
        params: {},
      }),
    });

    const data = await response.json();
    logTest(
      'retrieve_exhibit - Missing Param',
      response.status === 400 && data.error?.code === 'INVALID_PARAMS',
      `Rejected missing description with 400 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('retrieve_exhibit - Missing Param', false, error instanceof Error ? error.message : String(error));
  }

  await server.stop();
  await vectorStore.close();
  await prisma.$disconnect();
}

async function testErrorHandling() {
  console.log('\n=== Testing Error Handling ===\n');

  const prisma = new PrismaClient();
  const vectorStore = new VectorStore({
    dbPath: './data/lancedb-test',
    tableName: 'chunks',
  });
  await vectorStore.initialize();

  const embeddingProvider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');

  const config: MCPServerConfig = {
    port: 3205,
    authMode: 'none',
  };

  const registry = await createRegistry(vectorStore, prisma, embeddingProvider);
  const server = new MCPServer(config, registry);

  await server.start();

  // Test 17: Invalid HTTP Method
  console.log('17. Invalid HTTP Method - GET Request');
  try {
    const response = await fetch('http://localhost:3205', {
      method: 'GET',
    });

    const data = await response.json();
    logTest(
      'Invalid Method - GET',
      response.status === 405 && data.error?.code === 'METHOD_NOT_ALLOWED',
      `Rejected GET request with 405 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('Invalid Method - GET', false, error instanceof Error ? error.message : String(error));
  }

  // Test 18: Invalid JSON
  console.log('18. Invalid JSON in Request Body');
  try {
    const response = await fetch('http://localhost:3205', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: 'invalid json {',
    });

    const data = await response.json();
    logTest(
      'Invalid JSON',
      response.status === 400 && data.error?.code === 'INVALID_REQUEST',
      `Rejected invalid JSON with 400 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('Invalid JSON', false, error instanceof Error ? error.message : String(error));
  }

  // Test 19: Missing Tool Name
  console.log('19. Missing Tool Name');
  try {
    const response = await fetch('http://localhost:3205', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        params: {},
      }),
    });

    const data = await response.json();
    logTest(
      'Missing Tool Name',
      response.status === 400 && data.error?.code === 'INVALID_REQUEST',
      `Rejected missing tool with 400 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('Missing Tool Name', false, error instanceof Error ? error.message : String(error));
  }

  // Test 20: Unknown Tool
  console.log('20. Unknown Tool Name');
  try {
    const response = await fetch('http://localhost:3205', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'unknown_tool',
        params: {},
      }),
    });

    const data = await response.json();
    logTest(
      'Unknown Tool',
      response.status === 404 && data.error?.code === 'TOOL_NOT_FOUND',
      `Rejected unknown tool with 404 and error code ${data.error?.code}`
    );
  } catch (error) {
    logTest('Unknown Tool', false, error instanceof Error ? error.message : String(error));
  }

  await server.stop();
  await vectorStore.close();
  await prisma.$disconnect();
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         MCP Server End-to-End Test Suite                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testAuthentication();
    await testMCPTools();
    await testErrorHandling();

    // Print summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                      Test Summary                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => r.passed === false).length;
    const total = results.length;

    console.log(`Total Tests: ${total}`);
    console.log(`\x1b[32mPassed: ${passed}\x1b[0m`);
    console.log(`\x1b[31mFailed: ${failed}\x1b[0m`);
    console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%\n`);

    if (failed > 0) {
      console.log('Failed Tests:');
      results.filter(r => !r.passed).forEach(r => {
        console.log(`  \x1b[31m✗\x1b[0m ${r.name}: ${r.message}`);
      });
      process.exit(1);
    } else {
      console.log('\x1b[32m✓ All tests passed!\x1b[0m\n');
      process.exit(0);
    }
  } catch (error) {
    console.error('\n\x1b[31mTest suite failed with error:\x1b[0m', error);
    process.exit(1);
  }
}

// Run tests
main();
