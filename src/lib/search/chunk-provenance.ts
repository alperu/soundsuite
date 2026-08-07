/**
 * ChunkProvenance — the shared structure-metadata shape every projection
 * carries (task #13 phase 2 / PLAN-ss-docparse §6.3 P0#2).
 *
 * SIX projections carry retrieved chunks to consumers: the LanceDB row,
 * rowToSearchResult, query_case_knowledge results, DeepSearchSource, the
 * deep route's sources map, and the AI route's inline sources type. A field
 * added to fewer than all six silently drops at the first gap (the
 * structureType leak). Spread this interface instead of re-listing fields.
 */
export interface ChunkProvenance {
  /** Source document id — Meta View deep-links (/vectors/metaview/doc-…). */
  documentId?: string;
  /** Dominant block type ('paragraph' | 'table' | 'footnote' | 'figure'). */
  blockType?: string;
  /** Heading context the chunk sits under (also inside chunk text). */
  headingPath?: string;
  /** Delimited '|SPEAKER|…|' RR speakers overlapping the chunk. */
  speakers?: string;
  /** Structured markdown for table chunks — synthesis/rendering form. */
  tableMarkdown?: string;
}

/** Pick the provenance fields off any richer object (typed spread helper). */
export function pickProvenance<T extends ChunkProvenance>(s: T): ChunkProvenance {
  return {
    ...(s.documentId ? { documentId: s.documentId } : {}),
    ...(s.blockType ? { blockType: s.blockType } : {}),
    ...(s.headingPath ? { headingPath: s.headingPath } : {}),
    ...(s.speakers ? { speakers: s.speakers } : {}),
    ...(s.tableMarkdown ? { tableMarkdown: s.tableMarkdown } : {}),
  };
}
