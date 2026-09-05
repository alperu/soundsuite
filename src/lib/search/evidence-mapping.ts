/**
 * Shared mapper from the deep-search source shape to the MCP `EvidenceItem`
 * contract. Used by both the `local` evidence engine and the `routed` report
 * tools so the two profiles emit identical evidence records.
 */

import type { EvidenceItem } from '../mcp/research-types';
import type { DeepSearchSource } from './deep-search';
import { sourceDedupKey } from './source-dedup';

const BLOCK_TYPES = new Set(['paragraph', 'table', 'footnote', 'figure']);

/** Stable, content-derived id so the same chunk maps to the same id across rounds. */
export function evidenceIdFor(source: DeepSearchSource): string {
  const key = sourceDedupKey(source.document, source.page, source.text);
  // FNV-1a 32-bit — short, deterministic, no crypto import on the hot path.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `ev_${h.toString(16).padStart(8, '0')}`;
}

export function sourceToEvidenceItem(
  source: DeepSearchSource,
  origin: EvidenceItem['source'],
  rerankScore?: number,
): EvidenceItem {
  const blockType = source.blockType && BLOCK_TYPES.has(source.blockType)
    ? (source.blockType as EvidenceItem['blockType'])
    : undefined;
  return {
    id: evidenceIdFor(source),
    documentId: source.documentId ?? '',
    text: source.text,
    score: source.score,
    ...(typeof rerankScore === 'number' ? { rerankScore } : {}),
    // Citation family — the caller cites from these; a UUID is not a citation.
    ...(source.citation ? { citation: source.citation } : {}),
    ...(source.citationShort ? { citationShort: source.citationShort } : {}),
    ...(typeof source.page === 'number' && Number.isFinite(source.page) ? { page: source.page } : {}),
    ...(source.document ? { document: source.document } : {}),
    ...(source.filingType ? { filingType: source.filingType } : {}),
    ...(typeof source.volumeNumber === 'number' && Number.isFinite(source.volumeNumber)
      ? { volumeNumber: source.volumeNumber }
      : {}),
    ...(source.caseNumber ? { caseNumber: source.caseNumber } : {}),
    ...(source.filingSlug ? { filingSlug: source.filingSlug } : {}),
    ...(blockType ? { blockType } : {}),
    ...(source.headingPath ? { headingPath: source.headingPath } : {}),
    ...(source.speakers ? { speakers: source.speakers } : {}),
    ...(source.tableMarkdown ? { tableMarkdown: source.tableMarkdown } : {}),
    ...(source.recordStatus ? { recordStatus: source.recordStatus } : {}),
    hits: Math.max(1, source.matchedSubQueries?.length ?? 1),
    source: origin,
  };
}

export function sourcesToEvidence(
  sources: DeepSearchSource[],
  origin: EvidenceItem['source'],
): EvidenceItem[] {
  return sources.map((s) => sourceToEvidenceItem(s, origin));
}

/** Unique document ids across a set of sources — the provenance record of what left the machine. */
export function documentIdsOf(sources: Array<{ documentId?: string }>): string[] {
  return Array.from(new Set(sources.map((s) => s.documentId).filter((id): id is string => !!id)));
}
