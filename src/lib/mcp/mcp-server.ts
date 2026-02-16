/**
 * DORMANT — This standalone HTTP server is no longer started at runtime.
 *
 * MCP tools are now served exclusively through the Next.js API route at
 * /api/mcp/execute, which calls the same ToolRegistry singleton directly.
 * This file is retained for reference and potential test scripts that may
 * spin up an isolated MCP server.
 *
 * See: src/app/api/mcp/execute/route.ts
 *
 * Original: MCPServer class for exposing document search capabilities via
 * Model Context Protocol. Delegates all tool execution to the ToolRegistry.
 *
 * Requirements: 7.1, 8.1, 9.1, 10.1, 10.2, 10.3, 10.4
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createLogger, Logger } from '../logger';
import { ToolRegistry } from './tool-registry';

/**
 * OAuth configuration for MCP server authentication
 */
export interface OAuthConfig {
  providerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Configuration for the MCP server
 */
export interface MCPServerConfig {
  port: number;
  authMode: 'oauth' | 'apikey' | 'none';
  apiKeys?: string[];
  oauthConfig?: OAuthConfig;
}

/**
 * MCP error response structure
 */
export interface MCPErrorResponse {
  error: {
    code: string;
    message: string;
    details?: any;
  };
}

// Legacy type re-exports (for backward compatibility with callers)
export type { QueryCaseKnowledgeParams as QueryParams, QueryCaseKnowledgeResult as QueryResult } from './tools/query-case-knowledge';
export type { ScanForPatternParams as ScanParams, ScanForPatternResult as ScanResult } from './tools/scan-for-pattern';
export type { RetrieveExhibitParams as ExhibitParams, RetrieveExhibitResult as ExhibitResult } from './tools/retrieve-exhibit';

/**
 * MCPServer — thin HTTP shell that delegates tool execution to ToolRegistry.
 */
export class MCPServer {
  private config: MCPServerConfig;
  private registry: ToolRegistry;
  private server: ReturnType<typeof createServer> | null = null;
  private logger: Logger;

  constructor(
    config: MCPServerConfig,
    registry: ToolRegistry,
  ) {
    this.config = config;
    this.registry = registry;
    this.logger = createLogger('MCPServer');
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        const authResult = await this.authenticateRequest(req);
        if (!authResult.authenticated) {
          this.logger.warn('Authentication failed', { message: authResult.message });
          this.sendError(res, 401, 'AUTH_FAILED', authResult.message || 'Authentication failed');
          return;
        }

        await this.handleRequest(req, res);
      } catch (error) {
        this.logger.error('MCP Server request error', error);
        if (error instanceof Error && error.message.includes('Invalid JSON')) {
          this.sendError(res, 400, 'INVALID_REQUEST', 'Invalid JSON in request body');
        } else {
          this.sendError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Internal server error');
        }
      }
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        this.logger.info('MCP Server listening', { port: this.config.port, authMode: this.config.authMode });
        resolve();
      });
      this.server!.on('error', (error) => {
        this.logger.error('MCP Server failed to start', error, { port: this.config.port });
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((error) => {
          if (error) {
            this.logger.error('Error stopping MCP Server', error);
            reject(error);
          } else {
            this.logger.info('MCP Server stopped');
            resolve();
          }
        });
      });
    }
  }

  // -------------------------------------------------------------------------
  // Authentication (unchanged)
  // -------------------------------------------------------------------------

  private async authenticateRequest(req: IncomingMessage): Promise<{ authenticated: boolean; message?: string }> {
    if (this.config.authMode === 'none') {
      return { authenticated: true };
    }

    if (this.config.authMode === 'apikey') {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey || typeof apiKey !== 'string') {
        return { authenticated: false, message: 'Missing X-API-Key header' };
      }
      if (!this.config.apiKeys || !this.config.apiKeys.includes(apiKey)) {
        return { authenticated: false, message: 'Invalid API key' };
      }
      return { authenticated: true };
    }

    if (this.config.authMode === 'oauth') {
      const authHeader = req.headers['authorization'];
      if (!authHeader || typeof authHeader !== 'string') {
        return { authenticated: false, message: 'Missing Authorization header' };
      }
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match || !match[1]) {
        return { authenticated: false, message: 'Invalid Authorization header format' };
      }
      return { authenticated: true };
    }

    return { authenticated: false, message: 'Unknown authentication mode' };
  }

  // -------------------------------------------------------------------------
  // Request handling — delegates to ToolRegistry
  // -------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only POST requests are supported');
      return;
    }

    const body = await this.parseRequestBody(req);
    if (!body || typeof body !== 'object') {
      this.sendError(res, 400, 'INVALID_REQUEST', 'Invalid request body');
      return;
    }

    const { tool, params } = body as { tool?: string; params?: any };
    if (!tool || typeof tool !== 'string') {
      this.sendError(res, 400, 'INVALID_REQUEST', 'Missing or invalid tool name');
      return;
    }

    // list_tools — return enabled tools from registry
    if (tool === 'list_tools') {
      const tools = this.registry.listTools()
        .filter(t => t.config.enabled)
        .map(t => ({
          name: t.metadata.name,
          description: t.metadata.description,
          inputSchema: t.metadata.inputSchema,
        }));
      this.sendSuccess(res, { tools });
      return;
    }

    // Execute via registry (handles readiness, rate-limits, logging)
    const result = await this.registry.execute(tool, params || {});

    if (!result.success) {
      const statusMap: Record<string, number> = {
        TOOL_NOT_FOUND: 404,
        TOOL_DISABLED: 403,
        TOOL_NOT_READY: 503,
        RATE_LIMITED: 429,
        INVALID_PARAMS: 400,
        INVALID_REGEX: 400,
        NOT_IMPLEMENTED: 501,
      };
      const status = statusMap[result.errorCode || ''] || 500;
      this.sendError(res, status, result.errorCode || 'EXECUTION_FAILED', result.error || 'Unknown error');
      return;
    }

    this.sendSuccess(res, result.data);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async parseRequestBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON in request body')); }
      });
      req.on('error', (error) => { reject(error); });
    });
  }

  private sendSuccess(res: ServerResponse, data: any): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, statusCode: number, code: string, message: string, details?: any): void {
    const errorResponse: MCPErrorResponse = { error: { code, message, details } };
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  }
}
