/**
 * Unified synthesis-context builder (task #13 phase 0b).
 *
 * Replaces six hand-copied `[cite]\ntext` loops (AI single-shot route,
 * deep-search report, buildSourceContext, multi-pass, RLM seed, RLM tool
 * results). Two behavioral fixes over the copies it replaces:
 *
 *  1. Budget overflow SKIPS the oversized block and continues — the old
 *   loops `break`-ed, so one oversized early block silently dropped every
 *   later source (live bug, confirmed by two independent audits).
 *  2. A per-block cap truncates oversized blocks into budget instead of
 *   losing them — required before table markdown lands in context
 *   (markdown is much larger than the flattened cell text it replaces).
 *
 * This is also the SINGLE INJECTION POINT for future structure enrichment
 * (PLAN-ss-docparse §6.3): heading/speaker/table-markdown injection happens
 * here or nowhere.
 */

export interface CiteContextSource {
  text: string;
  document: string;
  page: number;
  citation?: string;
  citationShort?: string;
}

/** Citation label fallback chain — identical across every call site. */
export function citeOf(s: CiteContextSource): string {
  return s.citation || s.citationShort || `${s.document}, p.${s.page}`;
}

/** Truncate a block's text to cap, marking the cut. */
export function truncateBlock(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap) + '…[truncated]', truncated: true };
}

export interface CiteContextOptions {
  /** Hard total budget for the joined context string. */
  maxTotalChars: number;
  /** Per-block cap; blocks over it are truncated, not dropped.
   * Default: a quarter of the total budget. */
  perBlockCap?: number;
  /** Separator between blocks (default '\n---\n'). */
  separator?: string;
  /** Trailing newline after each block's text (legacy shape of the
   * deep-search sites; the AI route had none). Default true. */
  trailingNewline?: boolean;
}

export interface CiteContextResult {
  contextBlock: string;
  usedCount: number;
  skippedCount: number;
  truncatedCount: number;
  totalChars: number;
}

export function buildCiteContext(
  sources: CiteContextSource[],
  opts: CiteContextOptions,
): CiteContextResult {
  const separator = opts.separator ?? '\n---\n';
  const perBlockCap = opts.perBlockCap ?? Math.max(500, Math.floor(opts.maxTotalChars / 4));
  const nl = opts.trailingNewline === false ? '' : '\n';

  const parts: string[] = [];
  let total = 0;
  let truncatedCount = 0;
  let skippedCount = 0;

  for (const s of sources) {
    const { text, truncated } = truncateBlock(s.text, perBlockCap);
    const block = `[${citeOf(s)}]\n${text}${nl}`;
    const cost = block.length + (parts.length > 0 ? separator.length : 0);
    if (total + cost > opts.maxTotalChars) {
      // Skip THIS block and keep going — a later, smaller block may still
      // fit. The old copies broke here and dropped everything after.
      skippedCount++;
      continue;
    }
    parts.push(block);
    total += cost;
    if (truncated) truncatedCount++;
  }

  return {
    contextBlock: parts.join(separator),
    usedCount: parts.length,
    skippedCount,
    truncatedCount,
    totalChars: total,
  };
}
