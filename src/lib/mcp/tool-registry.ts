/**
 * Central coordinator for MCP tools.
 *
 * Ties together tool instances, persisted configuration, execution logging,
 * dependency checking, and rate limiting.
 */

import { BaseMCPTool } from './tools/base-tool';
import {
  ToolConfigEntry,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolListEntry,
  ToolStats,
  ToolExecutionRecord,
} from './tool-types';
import { ToolConfigStore } from './tool-config-store';
import { ToolExecutionLogger } from './tool-execution-logger';

export class ToolRegistry {
  private tools = new Map<string, BaseMCPTool>();
  private configs = new Map<string, ToolConfigEntry>();
  private dependencyStatus = new Map<
    string,
    Array<{ key: string; label: string; required: boolean; satisfied: boolean }>
  >();

  constructor(
    private configStore: ToolConfigStore,
    private executionLogger: ToolExecutionLogger,
    private context: ToolExecutionContext,
  ) {}

  /** Expose execution context for lazy re-initialization of providers. */
  getContext(): ToolExecutionContext {
    return this.context;
  }

  /**
   * Register tools and load persisted configs (or fall back to defaults).
   */
  async registerAll(tools: BaseMCPTool[]): Promise<void> {
    const persistedConfigs = await this.configStore.getAllToolConfigs();

    for (const tool of tools) {
      const name = tool.getMetadata().name;
      this.tools.set(name, tool);
      this.configs.set(name, persistedConfigs.get(name) ?? tool.getDefaultConfig());
    }

    await this.refreshDependencies();
  }

  /**
   * Run all dependency checks and cache the results.
   */
  async refreshDependencies(): Promise<void> {
    const checks: Array<Promise<void>> = [];

    for (const [name, tool] of this.tools) {
      const deps = tool.getDependencies();
      if (deps.length === 0) {
        this.dependencyStatus.set(name, []);
        continue;
      }

      checks.push(
        Promise.all(
          deps.map(async (dep) => {
            let satisfied = false;
            try {
              satisfied = await dep.check();
            } catch {
              satisfied = false;
            }
            return { key: dep.key, label: dep.label, required: dep.required, satisfied };
          }),
        ).then((results) => {
          this.dependencyStatus.set(name, results);
        }),
      );
    }

    await Promise.all(checks);
  }

  /**
   * Check whether a tool is ready to execute.
   */
  isToolReady(toolName: string): { ready: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const deps = this.dependencyStatus.get(toolName) ?? [];

    for (const dep of deps) {
      if (dep.required && !dep.satisfied) {
        reasons.push(`Missing required dependency: ${dep.label}`);
      }
    }

    return { ready: reasons.length === 0, reasons };
  }

  /**
   * Execute a tool by name with pre-flight checks (enabled, ready, rate limit).
   *
   * @param contextOverlay Optional partial context fields to merge onto the
   *   base context (e.g. `{ aiProvider, aiModel }` from the execute route).
   */
  async execute(
    toolName: string,
    params: Record<string, any>,
    contextOverlay?: Partial<ToolExecutionContext>,
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, error: `Tool "${toolName}" not found`, errorCode: 'TOOL_NOT_FOUND', executionTimeMs: 0 };
    }

    const config = this.configs.get(toolName)!;
    if (!config.enabled) {
      return { success: false, error: `Tool "${toolName}" is disabled`, errorCode: 'TOOL_DISABLED', executionTimeMs: 0 };
    }

    const readiness = this.isToolReady(toolName);
    if (!readiness.ready) {
      return {
        success: false,
        error: readiness.reasons.join('; '),
        errorCode: 'TOOL_NOT_READY',
        executionTimeMs: 0,
      };
    }

    if (config.rateLimitPerMinute > 0) {
      const recentCount = this.executionLogger.getRecentExecutionCount(toolName, 60_000);
      if (recentCount >= config.rateLimitPerMinute) {
        return {
          success: false,
          error: `Rate limit exceeded for "${toolName}" (${config.rateLimitPerMinute}/min)`,
          errorCode: 'RATE_LIMITED',
          executionTimeMs: 0,
        };
      }
    }

    // Merge overlay (e.g. aiProvider/aiModel) onto the base context
    const ctx = contextOverlay
      ? { ...this.context, ...contextOverlay }
      : this.context;
    const result = await tool.execute(params, ctx, config);

    this.executionLogger.record({
      toolName,
      params,
      success: result.success,
      errorCode: result.errorCode,
      executionTimeMs: result.executionTimeMs,
      resultCount: Array.isArray(result.data) ? result.data.length : result.data ? 1 : 0,
    });

    return result;
  }

  /**
   * Build the full list of tools with metadata, config, dependencies, readiness, and stats.
   */
  listTools(): ToolListEntry[] {
    const allStats = this.executionLogger.getStats();
    const statsMap = new Map(allStats.map((s) => [s.toolName, s]));

    const entries: ToolListEntry[] = [];
    for (const [name, tool] of this.tools) {
      const config = this.configs.get(name)!;
      const deps = this.dependencyStatus.get(name) ?? [];
      const readiness = this.isToolReady(name);
      const stats: ToolStats = statsMap.get(name) ?? {
        toolName: name,
        totalExecutions: 0,
        successCount: 0,
        errorCount: 0,
        avgExecutionTimeMs: 0,
        lastExecutedAt: null,
      };

      entries.push({
        metadata: tool.getMetadata(),
        config,
        dependencies: deps,
        ready: readiness.ready,
        readyReasons: readiness.reasons,
        stats,
      });
    }
    return entries;
  }

  /**
   * Get a single tool's list entry, or null if not registered.
   */
  getTool(toolName: string): ToolListEntry | null {
    const tool = this.tools.get(toolName);
    if (!tool) return null;

    const config = this.configs.get(toolName)!;
    const deps = this.dependencyStatus.get(toolName) ?? [];
    const readiness = this.isToolReady(toolName);
    const statsArr = this.executionLogger.getStats(toolName);
    const stats: ToolStats = statsArr[0] ?? {
      toolName,
      totalExecutions: 0,
      successCount: 0,
      errorCount: 0,
      avgExecutionTimeMs: 0,
      lastExecutedAt: null,
    };

    return {
      metadata: tool.getMetadata(),
      config,
      dependencies: deps,
      ready: readiness.ready,
      readyReasons: readiness.reasons,
      stats,
    };
  }

  /**
   * Merge partial config updates for a tool and persist.
   */
  async updateToolConfig(toolName: string, updates: Partial<ToolConfigEntry>): Promise<void> {
    const existing = this.configs.get(toolName);
    if (!existing) return;

    const merged: ToolConfigEntry = {
      enabled: updates.enabled ?? existing.enabled,
      settings: updates.settings ? { ...existing.settings, ...updates.settings } : existing.settings,
      rateLimitPerMinute: updates.rateLimitPerMinute ?? existing.rateLimitPerMinute,
    };

    this.configs.set(toolName, merged);
    await this.configStore.setToolConfig(toolName, merged);
  }

  /** Forwarded to execution logger. */
  getStats(toolName?: string): ToolStats[] {
    return this.executionLogger.getStats(toolName);
  }

  /** Forwarded to execution logger. */
  getRecentRecords(toolName?: string, limit?: number): ToolExecutionRecord[] {
    return this.executionLogger.getRecentRecords(toolName, limit);
  }
}
