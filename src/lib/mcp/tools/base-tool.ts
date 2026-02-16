/**
 * Abstract base class for all MCP tools.
 *
 * Subclasses must implement `getMetadata()` and `executeImpl()`.
 * The base class handles timing, error normalisation and logging.
 */

import {
  ToolMetadata,
  ToolDependency,
  ToolConfigEntry,
  ToolExecutionContext,
  ToolExecutionResult,
} from '../tool-types';

export abstract class BaseMCPTool<TParams = any, TResult = any> {
  /** Return the static metadata for this tool. */
  abstract getMetadata(): ToolMetadata;

  /** Core execution logic — override in each tool. */
  abstract executeImpl(
    params: TParams,
    context: ToolExecutionContext,
    config: ToolConfigEntry,
  ): Promise<TResult>;

  /** External dependencies this tool requires (override to declare). */
  getDependencies(): ToolDependency[] {
    return [];
  }

  /** Default configuration (override to customise). */
  getDefaultConfig(): ToolConfigEntry {
    return { enabled: true, settings: {}, rateLimitPerMinute: 0 };
  }

  /** Optional param validation hook — throw to reject. */
  validateParams(_params: TParams): void {
    // no-op by default
  }

  /**
   * Public entry-point called by the ToolRegistry.
   * Wraps `executeImpl` with timing, logging and error normalisation.
   */
  async execute(
    params: TParams,
    context: ToolExecutionContext,
    config: ToolConfigEntry,
  ): Promise<ToolExecutionResult<TResult>> {
    const start = Date.now();
    try {
      this.validateParams(params);
      const data = await this.executeImpl(params, context, config);
      return {
        success: true,
        data,
        executionTimeMs: Date.now() - start,
      };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err?.code ?? 'EXECUTION_ERROR';
      context.logger.error(`[${this.getMetadata().name}] ${message}`, err);
      return {
        success: false,
        error: message,
        errorCode: code,
        executionTimeMs: Date.now() - start,
      };
    }
  }
}
