# MCP Server

The MCP (Model Context Protocol) Server exposes Sound Suite document search capabilities to AI assistants through a standardized HTTP API.

## Overview

The MCPServer class implements an HTTP server that provides three main tools:

1. **query_case_knowledge**: Semantic search using vector embeddings
2. **scan_for_pattern**: Regex pattern matching across documents
3. **retrieve_exhibit**: Search for exhibit images by description

## Features

- **Multiple Authentication Modes**:
  - OAuth: Using bearer tokens
  - API Key: Using X-API-Key header
  - None: Development mode with no authentication

- **Structured Error Responses**: All errors return consistent JSON format with error codes
- **CORS Support**: Allows cross-origin requests for web-based AI assistants
- **Request Validation**: Validates all parameters before processing

## Usage

### Basic Setup

```typescript
import { MCPServer } from './lib/mcp';
import { VectorStore } from './lib/vector';
import { PrismaClient } from '@prisma/client';
import { TransformersEmbeddingProvider } from './lib/ingestion';

// Initialize dependencies
const prisma = new PrismaClient();
const vectorStore = new VectorStore({
  dbPath: './data/lancedb',
  tableName: 'chunks',
});
await vectorStore.initialize();

const embeddingProvider = new TransformersEmbeddingProvider({
  provider: 'transformers',
  model: 'Xenova/all-MiniLM-L6-v2',
});

// Create MCP server with API key authentication
const server = new MCPServer(
  {
    port: 3001,
    authMode: 'apikey',
    apiKeys: ['your-api-key-here'],
  },
  vectorStore,
  prisma,
  embeddingProvider
);

// Start the server
await server.start();
console.log('MCP Server running on port 3001');
```

### Authentication Modes

#### API Key Authentication

```typescript
const config = {
  port: 3001,
  authMode: 'apikey',
  apiKeys: ['key1', 'key2', 'key3'],
};
```

Clients must include the `X-API-Key` header:

```bash
curl -X POST http://localhost:3001 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: key1" \
  -d '{"tool": "query_case_knowledge", "params": {"query": "contract terms"}}'
```

#### OAuth Authentication

```typescript
const config = {
  port: 3001,
  authMode: 'oauth',
  oauthConfig: {
    providerUrl: 'https://oauth.example.com',
    clientId: 'your-client-id',
    clientSecret: 'your-client-secret',
    redirectUri: 'http://localhost:3001/callback',
  },
};
```

Clients must include the `Authorization` header with a bearer token:

```bash
curl -X POST http://localhost:3001 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token-here" \
  -d '{"tool": "query_case_knowledge", "params": {"query": "contract terms"}}'
```

#### No Authentication (Development)

```typescript
const config = {
  port: 3001,
  authMode: 'none',
};
```

No authentication headers required. **Use only in development!**

## MCP Tools

### 1. query_case_knowledge

Perform semantic search on legal documents using natural language queries.

**Request:**
```json
{
  "tool": "query_case_knowledge",
  "params": {
    "query": "What are the contract terms?",
    "caseId": "optional-case-id",
    "limit": 10
  }
}
```

**Response:**
```json
{
  "results": [
    {
      "text": "The contract terms specify...",
      "document": "contract.pdf",
      "page": 5,
      "score": 0.85
    }
  ]
}
```

### 2. scan_for_pattern

Search for exact patterns in legal documents using regex.

**Request:**
```json
{
  "tool": "scan_for_pattern",
  "params": {
    "pattern": "\\$[0-9,]+",
    "caseId": "optional-case-id",
    "limit": 10
  }
}
```

**Response:**
```json
{
  "results": [
    {
      "text": "The settlement amount is $50,000...",
      "document": "settlement.pdf",
      "page": 3,
      "match": "$50,000"
    }
  ]
}
```

### 3. retrieve_exhibit

Find exhibit images by text description.

**Request:**
```json
{
  "tool": "retrieve_exhibit",
  "params": {
    "description": "photo of the accident scene",
    "caseId": "optional-case-id",
    "limit": 5
  }
}
```

**Response:**
```json
{
  "results": [
    {
      "imagePath": "/exhibits/case-123/doc-456_page2_img0.png",
      "ocrText": "Accident scene photo taken on...",
      "document": "evidence.pdf",
      "page": 2
    }
  ]
}
```

### 4. list_tools

Get the schema for all available MCP tools.

**Request:**
```json
{
  "tool": "list_tools",
  "params": {}
}
```

**Response:**
```json
{
  "tools": [
    {
      "name": "query_case_knowledge",
      "description": "Perform semantic search on legal documents...",
      "inputSchema": {
        "type": "object",
        "properties": { ... },
        "required": ["query"]
      }
    }
  ]
}
```

## Error Handling

All errors return a structured JSON response:

```json
{
  "error": {
    "code": "INVALID_REGEX",
    "message": "Invalid regex pattern: Unterminated group",
    "details": { ... }
  }
}
```

### Error Codes

- `AUTH_FAILED`: Authentication failed (401)
- `METHOD_NOT_ALLOWED`: Only POST requests are supported (405)
- `INVALID_REQUEST`: Invalid request body (400)
- `INVALID_PARAMS`: Invalid or missing parameters (400)
- `TOOL_NOT_FOUND`: Unknown tool name (404)
- `INVALID_REGEX`: Invalid regex pattern (400)
- `QUERY_FAILED`: Semantic search failed (500)
- `SCAN_FAILED`: Pattern scan failed (500)
- `RETRIEVE_FAILED`: Exhibit retrieval failed (500)
- `INTERNAL_ERROR`: Internal server error (500)

## Testing

Run the test script to verify the MCP server:

```bash
npx ts-node src/lib/mcp/test-mcp-server.ts
```

This will test:
- API key authentication (valid, invalid, missing)
- No authentication mode
- OAuth authentication (with token, without token)
- Tool listing

## Integration with AI Assistants

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sound-suite": {
      "url": "http://localhost:3001",
      "headers": {
        "X-API-Key": "your-api-key-here"
      }
    }
  }
}
```

### Cursor

Add to your Cursor settings:

```json
{
  "mcp.servers": [
    {
      "name": "sound-suite",
      "url": "http://localhost:3001",
      "headers": {
        "X-API-Key": "your-api-key-here"
      }
    }
  ]
}
```

## Requirements Validation

This implementation satisfies the following requirements:

- **Requirement 7.1**: MCP_Server exposes query_case_knowledge tool
- **Requirement 8.1**: MCP_Server exposes scan_for_pattern tool
- **Requirement 9.1**: MCP_Server exposes retrieve_exhibit tool
- **Requirement 10.1**: MCP_Server supports OAuth authentication
- **Requirement 10.2**: MCP_Server supports API key authentication
- **Requirement 10.3**: Unauthenticated requests are rejected with 401
- **Requirement 10.4**: Authenticated requests are validated before processing

## Architecture

```
MCPServer
├── HTTP Server (Node.js http module)
├── Authentication Middleware
│   ├── OAuth (Bearer token validation)
│   ├── API Key (X-API-Key header validation)
│   └── None (Development mode)
├── Request Router
│   ├── query_case_knowledge
│   ├── scan_for_pattern
│   ├── retrieve_exhibit
│   └── list_tools
└── Dependencies
    ├── VectorStore (LanceDB)
    ├── EmbeddingProvider (transformers.js/OpenAI/Claude)
    └── PrismaClient (SQLite)
```

## Next Steps

After implementing the MCP server, the next tasks are:

1. **Task 11.2**: Write property test for unauthenticated request rejection
2. **Task 11.3**: Write property test for credential validation
3. **Task 12.1**: Implement query_case_knowledge tool (already done in this implementation)
4. **Task 12.5**: Implement scan_for_pattern tool (already done in this implementation)
5. **Task 12.8**: Implement retrieve_exhibit tool (already done in this implementation)

## Notes

- The OAuth implementation is a placeholder. In production, you should:
  - Verify token signatures
  - Check token expiration
  - Validate tokens against the OAuth provider
  - Check token scopes/permissions
  
- For production deployment, consider:
  - Using HTTPS instead of HTTP
  - Implementing rate limiting
  - Adding request logging
  - Setting up monitoring and alerting
  - Using a proper OAuth library like `@modelcontextprotocol/oauth`
