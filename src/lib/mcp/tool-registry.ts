/**
 * Central coordinator for MCP tools.
 *
 * Ties together tool instances, persisted configuration, execution logging,
 * dependency checking, rate limiting — and, since the two-profile split
 * (docs/tasks/06-mcp-two-profiles.md), profile visibility and LLM policy.
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
import { ollamaAvailable } from './shared-dependencies';
import { enforceProvider, McpError, LOCAL_PROVIDER } from './llm-policy';
import type { McpProfile } from './research-types';

/** Reason string attached to LLM tools hidden from `local` while Ollama is down. */
export const OLLAMA_UNAVAILABLE_REASON =
  'Ollama unavailable — local profile pins LLM tools to Ollama';

export class ToolRegistry {
  private tools = new Map<string, BaseMCPTool>();
  private configs = new Map<string, ToolConfigEntry>();
  private dependencyStatus = new Map<
    string,
    Array<{ key: string; label: string; required: boolean; satisfied: boolean }>
  >();
  /** Last Ollama probe result, refreshed by `refreshDependencies()`. */
  private ollamaUp = false;

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
   * Run all dependency checks (plus the Ollama probe used for local-profile
   * gating) and cache the results.
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

    checks.push(
      ollamaAvailable()
        .then((ok) => { this.ollamaUp = ok; })
        .catch(() => { this.ollamaUp = false; }),
    );

    await Promise.all(checks);
  }

  // ---------------------------------------------------------------------------
  // Profile helpers
  // ---------------------------------------------------------------------------

  /** Whether a tool is exposed to `profile` (absent `profiles` = both). */
  private toolInProfile(tool: BaseMCPTool, profile: McpProfile): boolean {
    const profiles = tool.getMetadata().profiles;
    return !profiles || profiles.includes(profile);
  }

  /**
   * Whether a tool may call an LLM. Every tool outside the `search` category
   * is one of the LLM analysis tools; under `local` those additionally need
   * a reachable Ollama.
   */
  private toolNeedsLlm(tool: BaseMCPTool): boolean {
    return tool.getMetadata().category !== 'search';
  }

  /**
   * Check whether a tool is ready to execute.
   *
   * @param profile When `local`, LLM tools also require the cached Ollama
   *   probe to have succeeded.
   */
  isToolReady(toolName: string, profile?: McpProfile): { ready: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const deps = this.dependencyStatus.get(toolName) ?? [];

    for (const dep of deps) {
      if (dep.required && !dep.satisfied) {
        reasons.push(`Missing required dependency: ${dep.label}`);
      }
    }

    if (profile === 'local') {
      const tool = this.tools.get(toolName);
      if (tool && this.toolNeedsLlm(tool) && !this.ollamaUp) {
        reasons.push(OLLAMA_UNAVAILABLE_REASON);
      }
    }

    return { ready: reasons.length === 0, reasons };
  }

  /**
   * Execute a tool by name with pre-flight checks (profile, enabled, ready,
   * rate limit, LLM policy).
   *
   * @param contextOverlay Optional partial context fields to merge onto the
   *   base context (e.g. `{ aiProvider, aiModel }` from the execute route).
   * @param profile MCP profile the call runs under. Defaults to `local`
   *   (fail-closed): a caller that does not say otherwise never reaches a
   *   cloud provider through the registry.
   */
  async execute(
    toolName: string,
    params: Record<string, any>,
    contextOverlay?: Partial<ToolExecutionContext>,
    profile: McpProfile = 'local',
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, error: `Tool "${toolName}" not found`, errorCode: 'TOOL_NOT_FOUND', executionTimeMs: 0 };
    }

    if (!this.toolInProfile(tool, profile)) {
      return {
        success: false,
        error: `Tool "${toolName}" is not available in the "${profile}" profile`,
        errorCode: 'TOOL_NOT_IN_PROFILE',
        executionTimeMs: 0,
      };
    }

    const config = this.configs.get(toolName)!;
    if (!config.enabled) {
      return { success: false, error: `Tool "${toolName}" is disabled`, errorCode: 'TOOL_DISABLED', executionTimeMs: 0 };
    }

    // Under `local`, re-probe Ollama (cached 30 s) so a freshly-started
    // Ollama is picked up without waiting for the next refreshDependencies().
    if (profile === 'local' && this.toolNeedsLlm(tool)) {
      try {
        this.ollamaUp = await ollamaAvailable();
      } catch {
        this.ollamaUp = false;
      }
    }

    const readiness = this.isToolReady(toolName, profile);
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

    // LLM policy — the choke point. `local` refuses any non-Ollama provider
    // before the tool runs; `routed` passes the requested provider through.
    let resolvedProvider: string | undefined;
    try {
      resolvedProvider = enforceProvider(profile, contextOverlay?.aiProvider);
    } catch (err) {
      if (err instanceof McpError) {
        return { success: false, error: err.message, errorCode: err.code, executionTimeMs: 0 };
      }
      throw err;
    }

    const policyOverlay: Partial<ToolExecutionContext> = { profile };
    if (resolvedProvider) policyOverlay.aiProvider = resolvedProvider;
    if (profile === 'local' && !contextOverlay?.aiModel) {
      // No override: pin the model too, or callLLM's auto-detect could pick
      // a cloud provider when Ollama is not the first configured one.
      policyOverlay.aiProvider = LOCAL_PROVIDER;
      policyOverlay.aiModel = await resolveLocalModel();
    }

    // Merge overlay (e.g. aiProvider/aiModel) onto the base context, then the
    // policy overlay on top so nothing in the request can out-vote it.
    const ctx: ToolExecutionContext = { ...this.context, ...(contextOverlay ?? {}), ...policyOverlay };
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
   *
   * @param profile When given, only tools exposed to that profile are listed
   *   and readiness reflects the profile's policy (local ⇒ LLM tools need
   *   Ollama). Omit for the dashboard, which manages every tool.
   */
  listTools(profile?: McpProfile): ToolListEntry[] {
    const allStats = this.executionLogger.getStats();
    const statsMap = new Map(allStats.map((s) => [s.toolName, s]));

    const entries: ToolListEntry[] = [];
    for (const [name, tool] of this.tools) {
      if (profile && !this.toolInProfile(tool, profile)) continue;

      const config = this.configs.get(name)!;
      const deps = this.dependencyStatus.get(name) ?? [];
      const readiness = this.isToolReady(name, profile);
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

/**
 * Model for `local` calls that carry no override: the configured Ollama
 * completion model, else the ai-helper default. Config read failures fall
 * back to the default rather than blocking the call.
 */
async function resolveLocalModel(): Promise<string> {
  try {
    const { getConfig } = await import('../db/config');
    const config = await getConfig();
    if (config.ollamaCompletionModel) return config.ollamaCompletionModel;
  } catch {
    /* fall through */
  }
  const { DEFAULT_MODELS } = await import('./tools/ai-helper');
  return DEFAULT_MODELS.ollama;
}
