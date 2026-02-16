/**
 * Shared type definitions for the MCP tool system.
 */

import { VectorStore } from '../vector/vector-store';
import { EmbeddingProvider } from '../ingestion/embedding-provider';
import { PrismaClient } from '@prisma/client';
import { Logger } from '../logger';

// ---------------------------------------------------------------------------
// Tool categories
// ---------------------------------------------------------------------------

export type ToolCategory =
  | 'search'
  | 'contradiction'
  | 'argument'
  | 'timeline'
  | 'entity'
  | 'review';

/** Display colours per category (Tailwind class tokens). */
export const CATEGORY_COLORS: Record<ToolCategory, { bg: string; text: string }> = {
  search:        { bg: 'bg-blue-50',   text: 'text-blue-700' },
  contradiction: { bg: 'bg-red-50',    text: 'text-red-700' },
  argument:      { bg: 'bg-purple-50', text: 'text-purple-700' },
  timeline:      { bg: 'bg-amber-50',  text: 'text-amber-700' },
  entity:        { bg: 'bg-green-50',  text: 'text-green-700' },
  review:        { bg: 'bg-orange-50', text: 'text-orange-700' },
};

// ---------------------------------------------------------------------------
// Tool metadata & schemas
// ---------------------------------------------------------------------------

export interface ToolMetadata {
  /** Unique tool name (snake_case, matches MCP protocol) */
  name: string;
  /** Human-friendly name for display */
  displayName: string;
  /** Short description shown in tool cards */
  description: string;
  /** Semver-style version */
  version: string;
  /** Functional category */
  category: ToolCategory;
  /** JSON Schema for input parameters */
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ToolDependency {
  /** Machine-readable key (e.g. "groqApiKey", "vectorStore") */
  key: string;
  /** Human-readable label (e.g. "Groq API Key") */
  label: string;
  /** Whether the tool cannot run without this dependency */
  required: boolean;
  /** Async check that returns true when the dependency is satisfied */
  check: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ToolConfigEntry {
  /** Whether this tool is enabled and visible to clients */
  enabled: boolean;
  /** Arbitrary per-tool settings */
  settings: Record<string, any>;
  /** Max executions per minute (0 = unlimited) */
  rateLimitPerMinute: number;
}

// ---------------------------------------------------------------------------
// Execution context (injected at runtime)
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
  vectorStore: VectorStore;
  embeddingProvider: EmbeddingProvider;
  database: PrismaClient;
  logger: Logger;
  /** Provider/model override from the UI toolbar (passed per-request). */
  aiProvider?: string;
  aiModel?: string;
}

// ---------------------------------------------------------------------------
// Execution results
// ---------------------------------------------------------------------------

export interface ToolExecutionResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
  executionTimeMs: number;
}

// ---------------------------------------------------------------------------
// Execution history / logging
// ---------------------------------------------------------------------------

export interface ToolExecutionRecord {
  id: string;
  toolName: string;
  params: Record<string, any>;
  success: boolean;
  errorCode?: string;
  executionTimeMs: number;
  resultCount: number;
  timestamp: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Aggregated stats
// ---------------------------------------------------------------------------

export interface ToolStats {
  toolName: string;
  totalExecutions: number;
  successCount: number;
  errorCount: number;
  avgExecutionTimeMs: number;
  lastExecutedAt: string | null; // ISO 8601
}

// ---------------------------------------------------------------------------
// Registry list entry (returned by the registry to callers / API)
// ---------------------------------------------------------------------------

export interface ToolListEntry {
  metadata: ToolMetadata;
  config: ToolConfigEntry;
  dependencies: Array<{
    key: string;
    label: string;
    required: boolean;
    satisfied: boolean;
  }>;
  ready: boolean;
  readyReasons: string[];
  stats: ToolStats;
}
