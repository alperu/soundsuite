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

export interface EvidenceItem {
  id: string;
  documentId: string;
  text: string;
  score: number;
  rerankScore?: number;
  blockType?: 'paragraph' | 'table' | 'footnote' | 'figure';
  headingPath?: string;
  speakers?: string;
  tableMarkdown?: string;
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
  outline?: {
    sections: { title: string; evidenceIds: string[]; gap?: string }[];
    gaps: string[];
  };
  rlm?: { rounds: number; toolCalls: number; notes: string[] };
  stats: {
    retrievals: number;
    chunksFused: number;
    rerankPool: number;
    ms: number;
    phases: Record<string, number>;
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
}
