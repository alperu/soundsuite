/**
 * Test script for MCPServer class.
 *
 * This script demonstrates how to:
 * 1. Initialize the MCP server with different auth modes
 * 2. Start the server
 * 3. Make requests to the MCP tools
 * 4. Stop the server
 *
 * Run with: npx ts-node src/lib/mcp/test-mcp-server.ts
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

async function testMCPServer() {
  console.log('=== MCP Server Test ===\n');

  // Initialize dependencies
  console.log('1. Initializing dependencies...');

  const prisma = new PrismaClient();

  const vectorStore = new VectorStore({
    dbPath: './data/lancedb',
    tableName: 'chunks',
  });
  await vectorStore.initialize();

  const embeddingProvider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');

  // Test 1: API Key Authentication
  console.log('\n2. Testing API Key Authentication...');
  const apiKeyConfig: MCPServerConfig = {
    port: 3001,
    authMode: 'apikey',
    apiKeys: ['test-key-123', 'test-key-456'],
  };

  const registry1 = await createRegistry(vectorStore, prisma, embeddingProvider);
  const apiKeyServer = new MCPServer(apiKeyConfig, registry1);

  await apiKeyServer.start();
  console.log('✓ API Key server started on port 3001');

  // Test request with valid API key
  console.log('\n3. Testing valid API key request...');
  try {
    const response = await fetch('http://localhost:3001', {
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
      console.log('✓ Valid API key accepted');
      console.log('  Available tools:', data.tools?.map((t: any) => t.name).join(', '));
    } else {
      console.log('✗ Request failed:', response.status);
    }
  } catch (error) {
    console.log('✗ Request error:', error instanceof Error ? error.message : String(error));
  }

  // Test request with invalid API key
  console.log('\n4. Testing invalid API key request...');
  try {
    const response = await fetch('http://localhost:3001', {
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

    if (response.status === 401) {
      console.log('✓ Invalid API key rejected (401)');
    } else {
      console.log('✗ Expected 401, got:', response.status);
    }
  } catch (error) {
    console.log('✗ Request error:', error instanceof Error ? error.message : String(error));
  }

  // Test request without API key
  console.log('\n5. Testing request without API key...');
  try {
    const response = await fetch('http://localhost:3001', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'list_tools',
        params: {},
      }),
    });

    if (response.status === 401) {
      console.log('✓ Missing API key rejected (401)');
    } else {
      console.log('✗ Expected 401, got:', response.status);
    }
  } catch (error) {
    console.log('✗ Request error:', error instanceof Error ? error.message : String(error));
  }

  await apiKeyServer.stop();
  console.log('\n6. API Key server stopped');

  // Test 2: No Authentication (Development Mode)
  console.log('\n7. Testing No Authentication mode...');
  const noAuthConfig: MCPServerConfig = {
    port: 3002,
    authMode: 'none',
  };

  const registry2 = await createRegistry(vectorStore, prisma, embeddingProvider);
  const noAuthServer = new MCPServer(noAuthConfig, registry2);

  await noAuthServer.start();
  console.log('✓ No-auth server started on port 3002');

  // Test request without authentication
  console.log('\n8. Testing request without authentication...');
  try {
    const response = await fetch('http://localhost:3002', {
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
      console.log('✓ Request accepted without authentication');
      console.log('  Available tools:', data.tools?.map((t: any) => t.name).join(', '));
    } else {
      console.log('✗ Request failed:', response.status);
    }
  } catch (error) {
    console.log('✗ Request error:', error instanceof Error ? error.message : String(error));
  }

  await noAuthServer.stop();
  console.log('\n9. No-auth server stopped');

  // Test 3: OAuth Authentication
  console.log('\n10. Testing OAuth Authentication...');
  const oauthConfig: MCPServerConfig = {
    port: 3003,
    authMode: 'oauth',
    oauthConfig: {
      providerUrl: 'https://oauth.example.com',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:3003/callback',
    },
  };

  const registry3 = await createRegistry(vectorStore, prisma, embeddingProvider);
  const oauthServer = new MCPServer(oauthConfig, registry3);

  await oauthServer.start();
  console.log('✓ OAuth server started on port 3003');

  // Test request with Bearer token
  console.log('\n11. Testing OAuth Bearer token request...');
  try {
    const response = await fetch('http://localhost:3003', {
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
      console.log('✓ OAuth token accepted');
      console.log('  Available tools:', data.tools?.map((t: any) => t.name).join(', '));
    } else {
      console.log('✗ Request failed:', response.status);
    }
  } catch (error) {
    console.log('✗ Request error:', error instanceof Error ? error.message : String(error));
  }

  // Test request without Bearer token
  console.log('\n12. Testing request without OAuth token...');
  try {
    const response = await fetch('http://localhost:3003', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'list_tools',
        params: {},
      }),
    });

    if (response.status === 401) {
      console.log('✓ Missing OAuth token rejected (401)');
    } else {
      console.log('✗ Expected 401, got:', response.status);
    }
  } catch (error) {
    console.log('✗ Request error:', error instanceof Error ? error.message : String(error));
  }

  await oauthServer.stop();
  console.log('\n13. OAuth server stopped');

  // Cleanup
  await vectorStore.close();
  await prisma.$disconnect();

  console.log('\n=== Test Complete ===');
}

// Run tests
testMCPServer().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
