/**
 * Shared shapes for the vendor ops. A plain function returns `OpResult`
 * (plain JSON, no Hayson); the HTTP adapter encodes it as a grid and the MCP
 * bridge returns it verbatim — meta is the summary, rows are the detail
 * (docs/PLAN-haystack-mcp-agentic-etl.md §6.4 worked example).
 */
import type { prisma as PrismaInstance } from '@/lib/db/prisma';

/** The app's (extended) Prisma client, as `@/lib/db/prisma` exports it. */
export type OpPrisma = typeof PrismaInstance;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface OpResult<Row = any> {
  /** Case-level or corpus-level truth. A count here is ALWAYS for the whole
   *  set, never for the returned page. */
  meta: Record<string, unknown>;
  rows: Row[];
}

/** Who is calling, stamped onto every write as `ssProvenance`. */
export interface OpActor {
  actor: 'agent' | 'human' | 'system';
  /** e.g. 'mcp:routed', 'haystack-http', 'browser-proxy' */
  via: string;
  sessionId?: string;
  model?: string;
}

export interface OpContext {
  prisma: OpPrisma;
  actor: OpActor;
}

export class OpError extends Error {
  constructor(
    public readonly code: 'INVALID_PARAMS' | 'NOT_FOUND' | 'WRITE_DISABLED' | 'EXECUTION_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

/** Strip a Hayson-style `@` prefix and refuse blanks. */
export function bareId(raw: unknown, field = 'id'): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new OpError('INVALID_PARAMS', `${field} is required`);
  return raw.trim().replace(/^@/, '');
}

export function pageOf<T>(rows: T[], offset: number, limit: number): T[] {
  const start = Math.max(0, offset);
  return rows.slice(start, start + Math.max(0, limit));
}

/** Clamp a page size: undefined → default, over max → max. */
export function clampLimit(raw: unknown, def: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.floor(raw));
}

export function offsetOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function provenanceTag(actor: OpActor, op: string): Record<string, unknown> {
  return {
    ssProvenance: {
      actor: actor.actor,
      via: actor.via,
      op,
      at: new Date().toISOString(),
      ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
      ...(actor.model ? { model: actor.model } : {}),
    },
  };
}
