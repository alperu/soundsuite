/**
 * Shared contracts for the two-profile MCP surface
 * (docs/tasks/06-mcp-two-profiles.md, REPORT-v2.1 Appendix A/B/C).
 *
 * `local`  — evidence engine. Ollama/sidecar only, never synthesises prose.
 * `routed` — Sound Suite as LLM router. Any configured provider, per tier.
 *
 * Everything under src/lib/mcp that touches profiles, tiers, evidence or
 * research jobs imports from here so the three work streams (foundation,
 * local, routed) agree on one vocabulary.
 */

import type { EffortLevel } from '../ai/models';

export type { EffortLevel };

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export type McpProfile = 'local' | 'routed';

export const MCP_PROFILES: readonly McpProfile[] = ['local', 'routed'] as const;

/**
 * Parse an untrusted profile value. Fail-closed: anything that is not exactly
 * the string `'routed'` is `'local'`, so a missing / malformed / spoofed value
 * can never widen a session to cloud providers.
 */
export function parseProfile(v: unknown): McpProfile {
  return v === 'routed' ? 'routed' : 'local';
}

/**
 * Strict parser for LISTING endpoints (`GET /api/mcp/tools`,
 * `GET /api/mcp/claude-tools`). Unlike `parseProfile` this does not coerce:
 *   - `null` / `undefined` / `''` → `'local'` (missing = the safe default)
 *   - `'local'` / `'routed'`      → that profile
 *   - `'all'`                     → `'all'` (dashboard-only: every tool, no policy stamp)
 *   - anything else               → `null` (caller answers 400 INVALID_PROFILE)
 * Execute keeps `parseProfile` (fail-closed to `local`); listing must not
 * silently mislabel a typo'd profile, so it rejects instead.
 */
export function parseProfileStrict(v: unknown): McpProfile | 'all' | null {
  if (v === null || v === undefined || v === '') return 'local';
  if (v === 'local' || v === 'routed' || v === 'all') return v;
  return null;
}

// ---------------------------------------------------------------------------
// Research modes / tiers
// ---------------------------------------------------------------------------

/** What a caller may request. `auto` lets the query router pick a tier. */
export type ResearchMode = 'auto' | 'fast' | 'deep' | 'deep-report' | 'deep-rlm';

/** A concrete tier after routing — the keys of a routing table. */
export type ResearchTier = Exclude<ResearchMode, 'auto'>;

export const RESEARCH_TIERS: readonly ResearchTier[] = ['fast', 'deep', 'deep-report', 'deep-rlm'] as const;

// ---------------------------------------------------------------------------
// Evidence (Appendix A)
// ---------------------------------------------------------------------------

/**
 * Default caps on what leaves the machine in one evidence payload. Without
 * them a `fast` run returned 80 items / ~97 KB in a single block (REPORT-v4
 * N-2), which floods the caller's context. Overridable per request via
 * `retrieval.maxEvidence` / `retrieval.maxCharsPerChunk` (or the same two
 * knobs at the top level of the tool params).
 */
export const EVIDENCE_DEFAULTS = { maxEvidence: 40, maxCharsPerChunk: 1200 } as const;

export interface EvidenceItem {
  id: string;
  documentId: string;
  text: string;
  score: number;
  rerankScore?: number;
  // -- Citation family (REPORT-v4 N-1) --------------------------------------
  // The retrieval layer already produces these; without them a client holds a
  // UUID and a paragraph and cannot cite anything. All optional: a chunk from
  // a chat attachment or a document without filing metadata carries fewer.
  /** Full citation string as the retrieval layer formatted it. */
  citation?: string;
  /** Abbreviated citation for inline use. */
  citationShort?: string;
  /** 1-based page number the chunk was found on. */
  page?: number;
  /** Human-readable document name (`documentId` stays the opaque id). */
  document?: string;
  /** Filing type of the source document (e.g. 'motion', 'order'). */
  filingType?: string;
  /** Volume number for multi-volume records. */
  volumeNumber?: number;
  /** Cause / case number of the source document. */
  caseNumber?: string;
  /** Slug of the filing the document belongs to — dashboard deep links. */
  filingSlug?: string;
  blockType?: 'paragraph' | 'table' | 'footnote' | 'figure';
  headingPath?: string;
  speakers?: string;
  tableMarkdown?: string;
  /** 'draft' = unfiled working copy; never present as filed record. */
  recordStatus?: 'filed' | 'draft' | 'unknown';
  hits: number;
  source: 'retrieval' | 'pattern' | `rlm-round-${number}`;
  rlmNote?: string;
}

export interface EvidenceResult {
  query: string;
  routing: {
    requested: ResearchMode;
    mode: ResearchMode;
    reason: string;
    confidence: number;
    /** Request fields the `local` profile silently ignored (e.g. provider). */
    ignored?: string[];
  };
  subQueries: string[];
  evidence: EvidenceItem[];
  /** `null` when the outline step produced nothing — never a fabricated one. */
  outline?: {
    sections: { title: string; evidenceIds: string[]; gap?: string }[];
    gaps: string[];
  } | null;
  rlm?: { rounds: number; toolCalls: number; notes: string[] };
  stats: {
    retrievals: number;
    chunksFused: number;
    rerankPool: number;
    ms: number;
    phases: Record<string, number>;
    /** Caps applied to this payload, so truncation is visible to the caller. */
    caps?: {
      maxEvidence: number;
      maxCharsPerChunk: number;
      /** True when items were dropped to satisfy `maxEvidence`. */
      evidenceTruncated: boolean;
      /** How many items the pipeline accumulated BEFORE `maxEvidence` trimmed
       * them — always present, equal to `evidence.length` when nothing was
       * dropped. `evidenceTruncated` says items are missing; this says how
       * many there were, for a client that polls `research_result` and never
       * sees the `cap` progress event. */
      evidenceTotalBeforeCap: number;
      /** How many of the RETURNED items had their `text` shortened to satisfy
       * `maxCharsPerChunk`. Counted over the returned set only, so
       * `chunksTruncated <= evidence.length` holds by construction (the slice
       * itself still happens at item construction, before the count cap, so
       * items streamed via `onEvidence` are bounded too). Covers `text` only —
       * `tableMarkdown` has its own counter. */
      chunksTruncated: number;
      /** Same shape and same counting rule, for items whose `tableMarkdown`
       * was shortened to satisfy `maxCharsPerChunk`. Separate from
       * `chunksTruncated` so that counter keeps meaning "text was cut". */
      tablesTruncated: number;
    };
  };
  profile: 'local';
  localOnly: true;
  modelsUsed: Record<'decompose' | 'rerank' | 'rlm' | 'outline', string>;
}

// ---------------------------------------------------------------------------
// Tier settings (Appendix C) and routing
// ---------------------------------------------------------------------------

export interface TierSettings {
  provider: string;
  model?: string;
  effort?: EffortLevel;
  thinking?: boolean;
  maxTokens?: number;
  multiPass?: boolean;
  useRlm?: boolean;
  rlmMaxRounds?: number;
}

// ---------------------------------------------------------------------------
// Report (Appendix B)
// ---------------------------------------------------------------------------

export interface ReportResult extends Omit<EvidenceResult, 'profile' | 'localOnly' | 'modelsUsed'> {
  profile: 'routed';
  /** Finished prose (markdown). */
  report: string;
  /** True on report_status before completion. */
  partial?: boolean;
  routing: EvidenceResult['routing'] & { resolved: TierSettings; presetUsed?: string };
  cost: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    /** True when the pipeline did not surface real usage and the counts are a chars/3.2 estimate. */
    estimated?: boolean;
  };
  provenance: { documentIdsSent: string[]; provider: string };
  modelsUsed: Record<'decompose' | 'rerank' | 'rlm' | 'outline' | 'synthesis', string>;
}

// ---------------------------------------------------------------------------
// Presets v2 (Part C.1)
// ---------------------------------------------------------------------------

/** Retrieval-side knobs — the only preset section the `local` profile honours. */
export interface RetrievalSettings {
  rerankPoolSize?: number;
  limitPerSubQuery?: number;
  rlmMaxRounds?: number;
  maxEvidence?: number;
  /** Hard cap on the characters of each chunk's `text` AND of its
   * `tableMarkdown`, applied to the two independently. Longer text is cut at a
   * word boundary with a trailing ellipsis; a longer table is cut on a row
   * boundary with a `… (table truncated)` marker. Default 1200. */
  maxCharsPerChunk?: number;
  /** Hard cap on the LLM decompose step (ms); on expiry the engine falls back
   * to a zero-LLM heuristic split. Default 20 000. */
  decomposeTimeoutMs?: number;
  /** Hard cap on the LLM evidence-outline step (ms); on expiry the outline is
   * a per-document grouping. Default 60 000. */
  outlineTimeoutMs?: number;
}

export interface PresetV2 {
  version: 2;
  name: string;
  // UI-level knobs (kept for parity with the dashboard preset blob)
  deep?: boolean;
  rlm?: boolean;
  multiPass?: boolean;
  thinking?: boolean;
  effort?: EffortLevel;
  maxTokens?: number;
  provider?: string;
  model?: string;
  includeCaseScope?: boolean;
  caseId?: string;
  // MCP router (routed profile only)
  routing?: Partial<Record<ResearchTier, TierSettings>>;
  // Retrieval side
  retrieval?: RetrievalSettings;
}

// ---------------------------------------------------------------------------
// gatherEvidence() options and progress
// ---------------------------------------------------------------------------

export interface ResearchProgress {
  phase: string;
  message: string;
  rlmRound?: number;
  rlmMaxRounds?: number;
  detail?: Record<string, unknown>;
}

export interface GatherEvidenceOptions {
  profile: McpProfile;
  localOnly: boolean;
  mode?: ResearchMode;
  caseId?: string;
  whereClauses?: string[];
  history?: { role: 'user' | 'assistant'; content: string }[];
  provider?: string;
  model?: string;
  thinking?: boolean;
  effort?: EffortLevel;
  retrieval?: RetrievalSettings;
  signal?: AbortSignal;
  onProgress?: (p: ResearchProgress) => void;
  onEvidence?: (items: EvidenceItem[]) => void;
  onThoughts?: (text: string) => void;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Research jobs (Part D)
// ---------------------------------------------------------------------------

export type ResearchJobKind = 'research' | 'report';

export type ResearchJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface ResearchJobEvent {
  seq: number;
  ts: number;
  type: 'progress' | 'evidence' | 'thoughts' | 'token' | 'result' | 'error' | 'cancelled';
  payload: unknown;
}

export interface ResearchJobStatusView {
  id: string;
  kind: ResearchJobKind;
  profile: McpProfile;
  status: ResearchJobStatus;
  phase?: string;
  /** Total evidence delivered so far; pass back as `cursor` to get only new items. */
  cursor: number;
  /** Evidence items with index >= the requested cursor. */
  evidence: EvidenceItem[];
  newEvidenceCount: number;
  outline?: EvidenceResult['outline'];
  rlmNotes: string[];
  /** Accumulated synthesis text — routed profile only. */
  partialReport?: string;
  cost?: ReportResult['cost'];
  error?: string;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  /** When the current `phase` began (ms epoch) — job start until the first progress event. */
  phaseStartedAt: number;
  /** Time spent in the current `phase` so far (frozen once the job finishes). */
  phaseElapsedMs: number;
}
