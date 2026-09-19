/**
 * The MCP bridge over the vendor Haystack ops (plan §6, §6.3).
 *
 * One tool per catalogued op, generated from `VENDOR_OPS` — the same spec the
 * `ops` grid advertises — so an op registered there is exposed here with no
 * hand-written tool. The tool calls `runVendorOp` in-process: never HTTP to
 * ourselves, never Hayson. What comes back is `{ meta, rows }` plain JSON.
 *
 * Registration is not exposure:
 *   - `read` ops: both profiles, `category: 'search'` (no LLM, so they answer
 *     on a degraded fleet).
 *   - `write` ops: `profiles: ['routed']`, and `dryRun=false` is additionally
 *     refused unless the server runs with `SS_HAYSTACK_WRITE=1`. The `local`
 *     profile is fail-closed by design and never sees them.
 *   - `llm` ops: `profiles: ['routed']`, `category: 'entity'` so the registry's
 *     LLM policy applies; the op calls OpenRouter with an explicit model and
 *     the profile policy still refuses it under `local`.
 *   - the standard `commit` op is NOT here. Its patch is a loaded weapon (§8.5).
 */
import { BaseMCPTool } from './base-tool';
import type { ToolConfigEntry, ToolExecutionContext, ToolMetadata } from '../tool-types';
import { McpError } from '../llm-policy';
import {
  OpError,
  VENDOR_OPS,
  paramsToJsonSchema,
  runVendorOp,
  type OpResult,
  type VendorOpSpec,
} from '@/lib/haystack/ops';

const OP_ERROR_TO_MCP: Record<OpError['code'], string> = {
  INVALID_PARAMS: 'INVALID_PARAMS',
  NOT_FOUND: 'NOT_FOUND',
  WRITE_DISABLED: 'POLICY_VIOLATION',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
};

export class HaystackOpTool extends BaseMCPTool<Record<string, unknown>, OpResult> {
  constructor(private readonly spec: VendorOpSpec) {
    super();
  }

  getMetadata(): ToolMetadata {
    const gated = this.spec.exposure !== 'read';
    const suffix =
      this.spec.exposure === 'write'
        ? ' WRITE — dryRun defaults to true; dryRun=false needs SS_HAYSTACK_WRITE=1 on the server.'
        : this.spec.exposure === 'llm'
          ? ' Calls a model over OpenRouter; costs money; writes nothing.'
          : ' Read-only.';
    return {
      name: this.spec.name,
      displayName: this.spec.dis,
      description: `${this.spec.doc}${suffix} Returns { meta, rows }: meta counts are for the whole set, rows page.`,
      version: '1.0.0',
      category: this.spec.exposure === 'llm' ? 'entity' : 'search',
      ...(gated ? { profiles: ['routed'] as const } : {}),
      inputSchema: paramsToJsonSchema(this.spec.params),
    } as ToolMetadata;
  }

  getDependencies() {
    return [];
  }

  protected rejectsUnknownParams(): boolean {
    return true;
  }

  async executeImpl(
    params: Record<string, unknown>,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<OpResult> {
    try {
      return await runVendorOp(this.spec.name, params ?? {}, {
        actor: {
          actor: 'agent',
          via: `mcp:${context.profile ?? 'unknown'}`,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.aiModel ? { model: context.aiModel } : {}),
        },
        trusted: false,
        llmContext: context,
      });
    } catch (err) {
      if (err instanceof OpError) throw new McpError(OP_ERROR_TO_MCP[err.code] as any, err.message);
      throw err;
    }
  }
}

export function getHaystackOpTools(): BaseMCPTool[] {
  return VENDOR_OPS.map((spec) => new HaystackOpTool(spec));
}
