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
import { McpError } from '../llm-policy';

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
   * Presence check for every field in the tool's declared
   * `inputSchema.required`. Derived from the schema rather than hand-written
   * per tool, so it cannot drift from what the tool advertises to clients.
   *
   * Rejects `undefined`, `null` and blank strings only — a required param may
   * legitimately be an object (`preset`), a number or a boolean.
   */
  private validateRequiredParams(params: TParams): void {
    const required = this.getMetadata().inputSchema?.required;
    if (!Array.isArray(required)) return;

    const bag = (params ?? {}) as Record<string, unknown>;
    for (const field of required) {
      const value = bag[field];
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        throw new McpError('INVALID_PARAMS', `${field} is required`);
      }
    }
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
      this.validateRequiredParams(params);
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
      // Some errors embed document text in `message` for the caller's benefit
      // (e.g. LLM_PARSE_ERROR's raw snippet). Those carry a redacted twin;
      // prefer it for the log line so case text never persists.
      const redacted: string | undefined = err?.logSafeMessage;
      context.logger.error(
        `[${this.getMetadata().name}] ${redacted ?? message}`,
        // Withhold the error object too — its `message`/stack carry the snippet.
        redacted ? { code } : err,
      );
      return {
        success: false,
        error: message,
        errorCode: code,
        executionTimeMs: Date.now() - start,
      };
    }
  }
}
