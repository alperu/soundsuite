/**
 * The adapter: one entry point every boundary calls.
 *
 *   HTTP op   ─► runVendorOp ─► plain function ─► Prisma / fs / model
 *   MCP tool  ─► runVendorOp ─►      ▲
 *   browser   ─► (proxy) ──────────  └── the single implementation
 *
 * It coerces raw parameters against the op's spec (query strings arrive as
 * strings), enforces the write gate, stamps the actor, and returns plain JSON.
 * Hayson never enters here; the HTTP route encodes the result as a grid.
 */
import { prisma } from '@/lib/db/prisma';
import type { ToolExecutionContext } from '@/lib/mcp/tool-types';
import { vendorOpSpec, type OpParam, type VendorOpSpec } from './catalogue';
import { OpError, type OpActor, type OpContext, type OpPrisma, type OpResult } from './types';
import { ssScopeGraph } from './scope-graph';
import { ssWorklist } from './worklist';
import { ssFolderSurvey } from './folder-survey';
import { ssIngestStatus } from './ingest-status';
import { ssReadCase } from './read-case';
import { ssCaseEnsure } from './case-ensure';
import { ssPromoteDiscovered, ssRequeueErrored } from './promote';
import { ssAutoIngestApply, ssAutoIngestPlan } from './auto-ingest';

export { VENDOR_OPS, VENDOR_OP_NAMES, STANDARD_OP_PARAMS, vendorOpSpec, paramsToJsonSchema } from './catalogue';
export type { VendorOpSpec, OpParam, OpExposure } from './catalogue';
export { OpError } from './types';
export type { OpResult, OpActor } from './types';

export const WRITE_GATE_ENV = 'SS_HAYSTACK_WRITE';

/** Writes are off unless the process says otherwise (plan §7.1). */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WRITE_GATE_ENV] === '1' || env[WRITE_GATE_ENV] === 'true';
}

export interface RunOpOptions {
  actor: OpActor;
  /**
   * The same-origin browser proxy sets this: the operator at the keyboard is
   * the review gate, so the env gate does not apply. Every other caller —
   * the bearer-key HTTP API and the MCP bridge — is gated.
   */
  trusted?: boolean;
  /** MCP execution context, so an `llm` op inherits profile policy. */
  llmContext?: ToolExecutionContext;
  /** Injectable for tests. */
  client?: OpPrisma;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (ctx: OpContext, params: any, llm?: ToolExecutionContext) => Promise<OpResult<any>>;

const HANDLERS: Record<string, Handler> = {
  ssScopeGraph: (ctx, p) => ssScopeGraph(ctx, p),
  ssWorklist: (ctx, p) => ssWorklist(ctx, p),
  ssFolderSurvey: (ctx, p) => ssFolderSurvey(ctx, p),
  ssIngestStatus: (ctx, p) => ssIngestStatus(ctx, p),
  ssReadCase: (ctx, p) => ssReadCase(ctx, p),
  ssCaseEnsure: (ctx, p) => ssCaseEnsure(ctx, p),
  ssPromoteDiscovered: (ctx, p) => ssPromoteDiscovered(ctx, p),
  ssRequeueErrored: (ctx, p) => ssRequeueErrored(ctx, p),
  ssAutoIngestPlan: (ctx, p, llm) => ssAutoIngestPlan(ctx, p, llm),
  ssAutoIngestApply: (ctx, p) => ssAutoIngestApply(ctx, p),
};

function coerceOne(name: string, p: OpParam, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  switch (p.type) {
    case 'string':
      return typeof raw === 'string' ? raw : String(raw);
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n)) throw new OpError('INVALID_PARAMS', `${name} must be an integer`);
      return n;
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new OpError('INVALID_PARAMS', `${name} must be a number`);
      return n;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      throw new OpError('INVALID_PARAMS', `${name} must be a boolean`);
    case 'object': {
      const v = typeof raw === 'string' ? safeJson(raw, name) : raw;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OpError('INVALID_PARAMS', `${name} must be an object`);
      return v;
    }
    case 'array': {
      const v = typeof raw === 'string' ? safeJson(raw, name) : raw;
      if (!Array.isArray(v)) throw new OpError('INVALID_PARAMS', `${name} must be an array`);
      return v;
    }
  }
}

function safeJson(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new OpError('INVALID_PARAMS', `${name} must be JSON`);
  }
}

/**
 * Validate and coerce a raw parameter bag against a spec. Unknown keys are
 * rejected: a silently dropped knob reads as a knob that had no effect.
 */
export function coerceParams(spec: VendorOpSpec, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const unknown = Object.keys(raw).filter((k) => !(k in spec.params) && raw[k] !== undefined);
  if (unknown.length) {
    throw new OpError(
      'INVALID_PARAMS',
      `unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Accepted: ${Object.keys(spec.params).sort().join(', ')}`,
    );
  }
  for (const [name, p] of Object.entries(spec.params)) {
    const v = coerceOne(name, p, raw[name]);
    if (v === undefined) {
      if (p.required) throw new OpError('INVALID_PARAMS', `${name} is required`);
      continue;
    }
    if (p.enum && typeof v === 'string' && !p.enum.includes(v)) {
      throw new OpError('INVALID_PARAMS', `${name} must be one of ${p.enum.join(', ')}`);
    }
    out[name] = v;
  }
  return out;
}

export async function runVendorOp(
  op: string,
  rawParams: Record<string, unknown>,
  options: RunOpOptions,
): Promise<OpResult> {
  const spec = vendorOpSpec(op);
  const handler = HANDLERS[op];
  if (!spec || !handler) throw new OpError('NOT_FOUND', `unknown vendor op: ${op}`);

  const params = coerceParams(spec, rawParams ?? {});

  // The gate. A `write` op with dryRun=true still runs — reporting what would
  // change is the point of the default — but an actual write needs the switch.
  const wantsWrite = spec.exposure === 'write' && params.dryRun === false;
  if (wantsWrite && !options.trusted && !writesEnabled()) {
    throw new OpError(
      'WRITE_DISABLED',
      `${op} with dryRun=false is refused: set ${WRITE_GATE_ENV}=1 on the server to enable agent writes, or apply from the dashboard.`,
    );
  }

  const ctx: OpContext = { prisma: options.client ?? prisma, actor: options.actor };
  return handler(ctx, params, options.llmContext);
}
