/**
 * Parse an untrusted `research_*` tool / HTTP request body into
 * `GatherEvidenceOptions` for the local evidence engine.
 *
 * The `local` profile honours only retrieval knobs. Anything that would
 * steer a model (provider, model, routing tables, effort, thinking, token
 * budgets) — whether at the top level or inside a `preset` object — is
 * dropped and named in `ignored` so the caller sees it had no effect
 * (REPORT-v2.1 Part C.3). A `preset` given by name is looked up in the
 * SearchPreset table for its `retrieval` section only.
 */

import type { GatherEvidenceOptions, ResearchMode, RetrievalSettings } from '../research-types';
import { RESEARCH_TIERS } from '../research-types';
import { McpError } from '../llm-policy';

export interface ParsedResearchParams {
  options: Pick<GatherEvidenceOptions, 'mode' | 'caseId' | 'whereClauses' | 'history' | 'retrieval'>;
  ignored: string[];
}

/** Fields the local profile never reads, at the top level or inside a preset. */
const STEERING_KEYS = ['provider', 'model', 'routing', 'effort', 'thinking', 'maxTokens', 'multiPass', 'useRlm', 'rlm', 'deep'] as const;

const RETRIEVAL_KEYS: (keyof RetrievalSettings)[] = [
  'rerankPoolSize', 'limitPerSubQuery', 'rlmMaxRounds', 'maxEvidence', 'maxCharsPerChunk',
  // v3 timeout knobs — ms values; omitted here they were unreachable from tool
  // params even though `gatherEvidence` reads them (REPORT-v4 scoping note).
  'decomposeTimeoutMs', 'outlineTimeoutMs',
];

/**
 * Retrieval knobs a model is likely to put at the TOP level of the request
 * instead of under `retrieval`. Accepted there and given precedence, rather
 * than silently dropped (REPORT-v4 N-2).
 */
const TOP_LEVEL_RETRIEVAL_KEYS: (keyof RetrievalSettings)[] = ['maxEvidence', 'maxCharsPerChunk'];

/**
 * Every top-level property a research request may carry. Anything else is an
 * `INVALID_PARAMS` error naming the key — a silently dropped knob reads to the
 * caller as a knob that had no effect. `query` / `profile` are stripped by the
 * callers before parsing but stay allowed so a direct caller is not punished.
 */
const HONOURED_TOP_LEVEL_KEYS: string[] = [
  'query', 'profile', 'caseId', 'mode', 'retrieval', 'history', 'preset', 'whereClauses',
  ...TOP_LEVEL_RETRIEVAL_KEYS,
];

const ALLOWED_TOP_LEVEL_KEYS = new Set<string>([...HONOURED_TOP_LEVEL_KEYS, ...STEERING_KEYS]);

/** Where a rejected key should have gone, when we can say. */
function placementHint(key: string): string {
  if ((RETRIEVAL_KEYS as string[]).includes(key)) return ` — put it under "retrieval"`;
  const lower = key.toLowerCase();
  for (const known of ALLOWED_TOP_LEVEL_KEYS) {
    if (known.toLowerCase() === lower) return ` — did you mean "${known}"?`;
  }
  return '';
}

function positiveInt(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n > 0 ? n : undefined;
}

export function parseRetrievalSettings(v: unknown): RetrievalSettings | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: RetrievalSettings = {};
  for (const key of RETRIEVAL_KEYS) {
    const n = positiveInt((v as Record<string, unknown>)[key]);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseResearchMode(v: unknown): ResearchMode | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === 'auto') return 'auto';
  if (typeof v === 'string' && (RESEARCH_TIERS as string[]).includes(v)) return v as ResearchMode;
  throw new McpError('INVALID_PARAMS', `mode must be one of auto, ${RESEARCH_TIERS.join(', ')}`);
}

function parseHistory(v: unknown): GatherEvidenceOptions['history'] {
  if (!Array.isArray(v)) return undefined;
  const turns = v
    .filter((t): t is { role: string; content: string } =>
      !!t && typeof t === 'object' && typeof (t as { content?: unknown }).content === 'string'
      && ((t as { role?: unknown }).role === 'user' || (t as { role?: unknown }).role === 'assistant'))
    .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content }));
  return turns.length > 0 ? turns : undefined;
}

/** Load the retrieval section of a saved preset by name. Null when unknown. */
async function loadPresetRetrieval(name: string): Promise<RetrievalSettings | null | undefined> {
  try {
    const { prisma } = await import('../../db/prisma');
    const row = await prisma.searchPreset.findFirst({ where: { name } });
    if (!row) return null;
    const settings = row.settings as Record<string, unknown> | null;
    return parseRetrievalSettings(settings?.retrieval);
  } catch {
    return null;
  }
}

export async function parseResearchParams(params: Record<string, unknown> | undefined): Promise<ParsedResearchParams> {
  const p = params ?? {};
  const ignored: string[] = [];

  const unknown = Object.keys(p).filter((k) => p[k] !== undefined && !ALLOWED_TOP_LEVEL_KEYS.has(k));
  if (unknown.length > 0) {
    const detail = unknown.map((k) => `"${k}"${placementHint(k)}`).join(', ');
    throw new McpError(
      'INVALID_PARAMS',
      // Only the honoured keys are listed: naming the steering keys here would
      // read as an invitation to send fields this profile then ignores.
      `unknown parameter${unknown.length > 1 ? 's' : ''}: ${detail}. Honoured parameters: ${[...HONOURED_TOP_LEVEL_KEYS].sort().join(', ')}`
      + ` (${STEERING_KEYS.join(', ')} are accepted but ignored by the local profile and reported in routing.ignored[])`,
    );
  }

  for (const key of STEERING_KEYS) {
    if (p[key] !== undefined) ignored.push(key);
  }

  const mode = parseResearchMode(p.mode);
  const caseId = typeof p.caseId === 'string' && p.caseId.trim() ? p.caseId.trim() : undefined;
  const whereClauses = Array.isArray(p.whereClauses)
    ? p.whereClauses.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : undefined;
  const history = parseHistory(p.history);

  // Explicit retrieval knobs win over anything a preset supplies.
  let presetRetrieval: RetrievalSettings | undefined;
  const preset = p.preset;
  if (typeof preset === 'string' && preset.trim()) {
    const found = await loadPresetRetrieval(preset.trim());
    if (found === null) ignored.push(`preset:${preset.trim()} (not found)`);
    else presetRetrieval = found;
  } else if (preset && typeof preset === 'object') {
    const obj = preset as Record<string, unknown>;
    for (const key of STEERING_KEYS) {
      if (obj[key] !== undefined) ignored.push(`preset.${key}`);
    }
    presetRetrieval = parseRetrievalSettings(obj.retrieval);
  }
  const explicit = parseRetrievalSettings(p.retrieval);
  // A top-level `maxEvidence` / `maxCharsPerChunk` is the obvious place for a
  // caller to put it, so it is honoured and wins over `retrieval`.
  const topLevel: RetrievalSettings = {};
  for (const key of TOP_LEVEL_RETRIEVAL_KEYS) {
    const n = positiveInt(p[key]);
    if (n !== undefined) topLevel[key] = n;
  }
  const merged = { ...(presetRetrieval ?? {}), ...(explicit ?? {}), ...topLevel };
  const retrieval = Object.keys(merged).length > 0 ? merged : undefined;

  return {
    options: {
      ...(mode ? { mode } : {}),
      ...(caseId ? { caseId } : {}),
      ...(whereClauses && whereClauses.length > 0 ? { whereClauses } : {}),
      ...(history ? { history } : {}),
      ...(retrieval ? { retrieval } : {}),
    },
    ignored,
  };
}
