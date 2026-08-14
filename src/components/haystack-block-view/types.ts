import { TAG_SPEC_BY_KIND, type EntityKind } from '@/components/case/tag-spec';

/** Shapes mirrored from GET /api/scope/graph and GET /api/scope/unconnected. */

export interface ScopeRefs {
  motionRef?: string | null;
  respondingTo?: string | null;
  replyingTo?: string | null;
  /** Order / judgment / decree → the motion it rules on. */
  resolves?: string | null;
  amends?: string | null;
  supersedes?: string | null;
  judgeRef?: string | null;
  movantRef?: string | null;
  respondentRef?: string | null;
  authoredBy?: string | null;
  [key: string]: unknown;
}

export interface ScopeDocument {
  id: string;
  status: string;
}

export interface ScopeFiling {
  id: string;
  filingType: string;
  label: string;
  docCount: number;
  indexedCount: number;
  refs: ScopeRefs;
  documents: ScopeDocument[];
  /** Entity kinds sharing this filing's id (`motion`, plus an attachment kind
   *  when a MotionAttachment row exists). A ref write must name the row that
   *  owns the slot, so the canvas needs this to commit an edge. */
  entityKinds?: string[];
  /** The one kind this filing *is* (`notice`, `reportersRecord`, `motion`, …),
   *  derived server-side. Prefer this over re-deriving from `entityKinds`: it
   *  is populated even when no entity row has been materialized yet. */
  primaryKind?: string;
}

/** A row from `GET /api/scope/unfiled` — a document no filing claims. */
export interface UnfiledDocument {
  id: string;
  caseId: string;
  label: string;
  status: string;
}

export interface ScopeCase {
  id: string;
  name: string;
  filings: ScopeFiling[];
  unfiledDocCount: number;
  unfiledIndexedCount: number;
}

export interface UnconnectedRow {
  entityKind: string;
  entityTable: 'Motion' | 'MotionAttachment';
  entityId: string;
  filingId: string | null;
  caseId: string | null;
  label: string;
  missing: string[];
}

export interface ScopeSelection {
  caseIds: string[];
  filingIds: string[];
}

/**
 * The API hands back raw DB strings; TagPanel only understands kinds that the
 * spec table knows. Rows with an unknown kind still list — they just select to
 * an empty panel rather than crashing the type contract.
 */
export function asEntityKind(kind: string | null | undefined): EntityKind | null {
  if (!kind) return null;
  return kind in TAG_SPEC_BY_KIND ? (kind as EntityKind) : null;
}
