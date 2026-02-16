/**
 * MCP (Model Context Protocol) Server module.
 *
 * Exports the MCPServer, ToolRegistry, and related types.
 */

export {
  MCPServer,
  type MCPServerConfig,
  type OAuthConfig,
  type QueryParams,
  type QueryResult,
  type ScanParams,
  type ScanResult,
  type ExhibitParams,
  type ExhibitResult,
  type MCPErrorResponse,
} from './mcp-server';

export { ToolRegistry } from './tool-registry';
export { ToolConfigStore } from './tool-config-store';
export { ToolExecutionLogger } from './tool-execution-logger';
export { getToolRegistry } from './get-tool-registry';
export { getAllTools } from './tools';

export type {
  ToolCategory,
  ToolMetadata,
  ToolDependency,
  ToolConfigEntry,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutionRecord,
  ToolStats,
  ToolListEntry,
} from './tool-types';
