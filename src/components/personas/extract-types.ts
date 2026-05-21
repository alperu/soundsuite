/**
 * Types shared between ExtractModal sub-components.
 *
 * Mirrors the shape we expect from Agent A's `/api/personas/extract` endpoint.
 * If field names diverge, update here.
 */

export type IntrinsicTag =
  | 'lawyer'
  | 'judge'
  | 'courtClerk'
  | 'courtReporter'
  | 'bailiff'
  | 'proSe';

export const INTRINSIC_TAGS: { name: IntrinsicTag; label: string }[] = [
  { name: 'lawyer', label: 'Lawyer' },
  { name: 'judge', label: 'Judge' },
  { name: 'courtClerk', label: 'Court Clerk' },
  { name: 'courtReporter', label: 'Court Reporter' },
  { name: 'bailiff', label: 'Bailiff' },
  { name: 'proSe', label: 'Pro Se' },
];

export type ContextualRole =
  | 'movant'
  | 'respondent'
  | 'plaintiff'
  | 'defendant'
  | 'author'
  | 'signer';

export const CONTEXTUAL_ROLES: { name: ContextualRole; label: string }[] = [
  { name: 'movant', label: 'Movant' },
  { name: 'respondent', label: 'Respondent' },
  { name: 'plaintiff', label: 'Plaintiff' },
  { name: 'defendant', label: 'Defendant' },
  { name: 'author', label: 'Author' },
  { name: 'signer', label: 'Signer' },
];

export interface DedupMatch {
  personaId: string;
  displayName: string;
  score: number;
  matchReason: string; // e.g. "bar number match", "name + email"
}

export interface ProposedRole {
  scopeKind: 'case' | 'motion' | 'motionEvent' | 'hearing' | 'doc';
  scopeId: string;
  scopeLabel: string; // human-readable, e.g. "Cause 12345 / MTD"
  contextualTags: ContextualRole[];
}

export interface ExtractCandidate {
  /** Client-generated id for keying the list — server may also send one. */
  id: string;
  displayName: string;
  barNumber?: string;
  email?: string;
  intrinsicTags: IntrinsicTag[];
  /** 100-char excerpt showing where the candidate was found. */
  sourceQuote?: string;
  /** Chunk id for "Show in doc" deep-link. */
  sourceChunkId?: string;
  dedupMatches: DedupMatch[];
  proposedRole?: ProposedRole;
  /** UI state: user toggles to include/exclude this card. */
  confirmed?: boolean;
  /** UI state: which dedup match selected ("__new__" = create new). */
  dedupChoice?: string;
}

export interface ExtractResponse {
  candidates: ExtractCandidate[];
  stagesRun: string[];
  recommendation?: 'review' | 'manual';
}

export type ModalState = 'picking' | 'extracting' | 'reviewing' | 'manual-fallback' | 'success';

export interface ExtractResult {
  created: number;
  updated: number;
  rolesAdded: number;
}

export interface DocumentSummary {
  id: string;
  fileName: string;
  caseLabel?: string;
  filingLabel?: string;
}
