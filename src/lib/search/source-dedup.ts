/**
 * Shared source-dedup key (task #13 phase 0a).
 *
 * The old key `document::page::text.slice(0,100)` collided by construction
 * on table fragments: StructuredChunker.emitTable deliberately repeats the
 * header row at the top of every fragment so each is self-explanatory, so
 * fragments 2..n differ only AFTER char 100 and all but the first were
 * silently dropped (live recall bug, confirmed by two independent audits).
 * Key on the FULL text — source lists are bounded (≤ a few hundred rows of
 * ≤ ~2k chars), so the memory cost is irrelevant next to the recall cost.
 *
 * Used by deep-search deduplicateAndMerge AND the AI single-shot route
 * (both its pattern-scan merge sites) — keep them on this one helper.
 */
export function sourceDedupKey(document: string, page: number, text: string): string {
  return `${document}::${page}::${text}`;
}
