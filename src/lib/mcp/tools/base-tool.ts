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

/**
 * Error codes a tool may surface to an MCP client verbatim.
 *
 * Anything else — a Prisma `PrismaClientKnownRequestError` (`P2023`), a driver
 * error, a bare `Error` — is reported as `EXECUTION_ERROR` with a generic
 * message; the real one only reaches the server log. Fail-closed by
 * construction: a new internal error class cannot leak an invocation string or
 * a query fragment to a caller just because it happens to carry a `.code`.
 *
 * Tools in this repo throw both `McpError` and plain `Error` objects with an
 * ad-hoc `.code` (e.g. `scan_for_pattern`'s `INVALID_REGEX`), so membership is
 * decided on the code, not the class.
 */
export const CALLER_SAFE_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_PARAMS',
  'INVALID_REGEX',
  'INVALID_PRESET',
  'INVALID_PROVIDER',
  'NO_PROVIDER',
  'NOT_FOUND',
  'POLICY_VIOLATION',
  // Retrieval-side operator guidance. Both name a setting to change and carry
  // no case text, and the dashboard's search routes key off them.
  'EMBEDDING_DIMENSION_MISMATCH',
  'EMBEDDING_UNAVAILABLE',
  'LLM_PARSE_ERROR',
  'LLM_SHAPE_ERROR',
  'JOB_NOT_FOUND',
  'JOB_RUNNING',
  'JOB_FAILED',
  'JOB_CANCELLED',
]);

/** Caller-facing text for anything not on the allowlist. */
const GENERIC_EXECUTION_MESSAGE =
  'The tool failed while executing; see the Sound Suite server logs for the underlying error.';

/**
 * Params a model is likely to invent because a *different* tool takes them.
 * Used only to enrich the `unknown parameter` message — the key is still
 * rejected. The hint is emitted only when the suggested name is actually
 * declared on the tool being called.
 */
const CROSS_TOOL_PARAM_HINTS: Record<string, string> = {
  caseScope: 'caseIds',
  caseIDs: 'caseIds',
  case_ids: 'caseIds',
  cases: 'caseIds',
  case: 'caseId',
  case_id: 'caseId',
  caseNumber: 'caseId',
  regex: 'pattern',
  q: 'query',
};

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
   * Opt in to rejecting top-level params the tool's `inputSchema` does not
   * declare (`research_evidence` does the same in `research-params.ts`).
   *
   * Opt-in rather than global: a tool whose schema under-declares a param an
   * internal caller passes would start 400ing on a call that used to work.
   * Turn it on only once every caller's params are declared.
   */
  protected rejectsUnknownParams(): boolean {
    return false;
  }

  /**
   * Reject top-level keys the schema does not declare. A silently dropped
   * knob reads to the caller as a knob that had no effect — the same
   * false-negative class as a filter that never applied (docs/tasks/12).
   */
  private validateKnownParams(params: TParams): void {
    if (!this.rejectsUnknownParams()) return;
    const properties = this.getMetadata().inputSchema?.properties;
    if (!properties || typeof properties !== 'object') return;

    const declared = Object.keys(properties);
    const allowed = new Set(declared);
    const bag = (params ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(bag).filter((k) => bag[k] !== undefined && !allowed.has(k));
    if (unknown.length === 0) return;

    const hint = (key: string): string => {
      const lower = key.toLowerCase();
      for (const known of declared) {
        if (known.toLowerCase() === lower) return ` — did you mean "${known}"?`;
      }
      const suggestion = CROSS_TOOL_PARAM_HINTS[key];
      if (suggestion && allowed.has(suggestion)) return ` — use "${suggestion}" on this tool`;
      return '';
    };

    const detail = unknown.map((k) => `"${k}"${hint(k)}`).join(', ');
    throw new McpError(
      'INVALID_PARAMS',
      `unknown parameter${unknown.length > 1 ? 's' : ''}: ${detail}. ` +
        `Accepted parameters: ${[...declared].sort().join(', ')}`,
    );
  }

  /**
   * Runtime type check for every DECLARED top-level property, derived from the
   * schema so it cannot drift. Undeclared keys are `validateKnownParams`'
   * business; properties with no `type` (e.g. a `oneOf` union) are skipped.
   *
   * This is the guard that stops `caseId: ["A","B"]` reaching Prisma as a
   * `where: { id: [...] }` and 500ing with an invocation string.
   */
  private validateParamTypes(params: TParams): void {
    const properties = this.getMetadata().inputSchema?.properties as
      | Record<string, { type?: string; items?: { type?: string } }>
      | undefined;
    if (!properties) return;

    const bag = (params ?? {}) as Record<string, unknown>;
    for (const [field, schema] of Object.entries(properties)) {
      const expected = schema?.type;
      if (!expected) continue;
      const value = bag[field];
      // Absent, or an explicit null on an optional field: presence checking is
      // `validateRequiredParams`' job, and clients do send explicit nulls.
      if (value === undefined || value === null) continue;

      const ok =
        expected === 'string' ? typeof value === 'string'
        : expected === 'integer' ? typeof value === 'number' && Number.isInteger(value)
        : expected === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : expected === 'boolean' ? typeof value === 'boolean'
        : expected === 'array' ? Array.isArray(value)
        : expected === 'object' ? typeof value === 'object' && !Array.isArray(value)
        : true;

      if (!ok) {
        throw new McpError(
          'INVALID_PARAMS',
          `${field} must be ${expected === 'array' ? 'an array' : expected === 'integer' || expected === 'object' ? `an ${expected}` : `a ${expected}`}` +
            `, received ${Array.isArray(value) ? 'array' : typeof value}`,
        );
      }

      // One level into arrays: `caseIds: [1, 2]` is as wrong as `caseIds: 1`.
      const itemType = expected === 'array' ? schema.items?.type : undefined;
      if (itemType && Array.isArray(value)) {
        const bad = value.findIndex((v) =>
          itemType === 'string' ? typeof v !== 'string'
          : itemType === 'number' || itemType === 'integer' ? typeof v !== 'number'
          : itemType === 'boolean' ? typeof v !== 'boolean'
          : false,
        );
        if (bad >= 0) {
          throw new McpError(
            'INVALID_PARAMS',
            `${field}[${bad}] must be a ${itemType}, received ${typeof value[bad]}`,
          );
        }
      }
    }
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
      // Unknown keys first: a typo'd key is usually also the *cause* of the
      // presence failure, so `unknown parameter "patern"` beats the misleading
      // `pattern is required`.
      this.validateKnownParams(params);
      this.validateRequiredParams(params);
      this.validateParamTypes(params);
      this.validateParams(params);
      const data = await this.executeImpl(params, context, config);
      return {
        success: true,
        data,
        executionTimeMs: Date.now() - start,
      };
    } catch (err: any) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const rawCode = typeof err?.code === 'string' ? err.code : undefined;
      // Allowlist, not denylist: an ORM error carries its own `.code`
      // (Prisma's `P2023`), so passing anything with a code through would
      // still ship `prisma.case.findUnique() … where: { id: [ … ] }` to the
      // client. Only codes this surface documents are caller-facing.
      const safe = !!rawCode && CALLER_SAFE_ERROR_CODES.has(rawCode);
      const code = safe ? rawCode! : 'EXECUTION_ERROR';
      const message = safe ? rawMessage : GENERIC_EXECUTION_MESSAGE;
      // Some errors embed document text in `message` for the caller's benefit
      // (e.g. LLM_PARSE_ERROR's raw snippet). Those carry a redacted twin;
      // prefer it for the log line so case text never persists.
      const redacted: string | undefined = err?.logSafeMessage;
      context.logger.error(
        `[${this.getMetadata().name}] ${redacted ?? rawMessage}`,
        // Withhold the error object too — its `message`/stack carry the snippet.
        redacted ? { code: rawCode ?? code } : err,
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
