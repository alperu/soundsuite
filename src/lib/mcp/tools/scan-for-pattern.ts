import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import { SearchQuery, MatchQuery, Operator } from '../../vector/vector-store';
import { getCitationFormatter, CitationInput } from '../../citations/citation-formatter';
import { detectLineNumbers } from '../../citations/line-number-detector';

export interface ScanForPatternParams {
  pattern: string;
  caseId?: string;
  limit?: number;
}

export interface ScanForPatternResult {
  results: Array<{
    text: string;
    document: string;
    page: number;
    match: string;
    citation?: string;
    citationShort?: string;
    filingType?: string;
    volumeNumber?: number;
    caseNumber?: string;
    filingSlug?: string;
  }>;
}

/**
 * Extract literal keywords from a regex pattern for FTS recall.
 * Strips regex metacharacters and returns meaningful words.
 */
function extractKeywordsFromPattern(pattern: string): string[] {
  // Remove regex metacharacters and special constructs
  const cleaned = pattern
    .replace(/\\[bBdDwWsSn.]/g, ' ')   // character classes
    .replace(/[.*+?^${}()|[\]\\]/g, ' ') // metacharacters
    .replace(/\{[^}]*\}/g, ' ')          // quantifiers like {2,3}
    .replace(/[<>]/g, ' ');

  return cleaned
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2); // Only meaningful words (2+ chars)
}

export class ScanForPatternTool extends BaseMCPTool<
  ScanForPatternParams,
  ScanForPatternResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'scan_for_pattern',
      displayName: 'Scan for Pattern',
      description: 'Search for exact patterns in legal documents using regex',
      version: '1.1.0',
      category: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for',
          },
          caseId: {
            type: 'string',
            description: 'Optional case ID to filter results',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 10)',
          },
        },
        required: ['pattern'],
      },
    };
  }

  validateParams(params: ScanForPatternParams): void {
    if (!params.pattern || typeof params.pattern !== 'string') {
      const err: any = new Error('Missing or invalid pattern parameter');
      err.code = 'INVALID_PARAMS';
      throw err;
    }
    try {
      new RegExp(params.pattern);
    } catch (error) {
      const err: any = new Error(
        `Invalid regex pattern: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      err.code = 'INVALID_REGEX';
      throw err;
    }
  }

  async executeImpl(
    params: ScanForPatternParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ScanForPatternResult> {
    const { pattern, caseId, limit = 10 } = params;

    context.logger.info('Handling scan_for_pattern', { pattern, caseId, limit });

    const regex = new RegExp(pattern, 'i');

    // Extract literal keywords from the regex pattern for FTS recall
    const keywords = extractKeywordsFromPattern(pattern);

    // Fetch more candidates than needed so we can post-filter with regex
    const fetchLimit = limit * 5;

    // Build search query — use FTS keywords for initial recall
    const searchQuery: SearchQuery = {
      limit: fetchLimit,
    };

    if (keywords.length > 0) {
      // Use FTS with extracted keywords (OR logic for broad recall)
      searchQuery.ftsQuery = new MatchQuery(keywords.join(' '), 'text', {
        operator: Operator.Or,
      });
    } else {
      // No useful keywords extracted — fall back to legacy LIKE with the raw pattern
      searchQuery.hybridQuery = pattern;
    }

    // Apply case filter if provided
    if (caseId) {
      searchQuery.filter = { caseId };
    }

    // Perform initial recall search
    const searchResults = await context.vectorStore.search(searchQuery);

    // Post-filter: apply the actual regex to each result
    const matchedResults = searchResults.filter((result) => regex.test(result.text));

    // Take only the requested limit
    const limitedResults = matchedResults.slice(0, limit);

    // Count distinct volumes per filing type for citation formatting
    const volumeCountMap = new Map<string, number>();
    if (caseId) {
      try {
        const filings = await (context.database as any).filing.findMany({
          where: { caseId },
          select: { filingType: true, volumeNumber: true },
        });
        const typeVolumes = new Map<string, Set<number>>();
        for (const f of filings) {
          if (!f.filingType) continue;
          if (!typeVolumes.has(f.filingType)) typeVolumes.set(f.filingType, new Set());
          typeVolumes.get(f.filingType)!.add(f.volumeNumber ?? 1);
        }
        for (const [type, vols] of typeVolumes) {
          volumeCountMap.set(type, vols.size);
        }
        // Supplement from document filenames
        const caseDocs = await context.database.document.findMany({
          where: { caseId },
          select: { fileName: true, documentType: true },
        });
        const docTypeVolumes = new Map<string, Set<number>>();
        for (const doc of caseDocs) {
          if (!doc.documentType) continue;
          const volMatch = doc.fileName?.match(/-VOL(\d+)/i);
          const vol = volMatch ? parseInt(volMatch[1], 10) : 1;
          if (!docTypeVolumes.has(doc.documentType)) docTypeVolumes.set(doc.documentType, new Set());
          docTypeVolumes.get(doc.documentType)!.add(vol);
        }
        for (const [type, vols] of docTypeVolumes) {
          if (vols.size > (volumeCountMap.get(type) ?? 0)) volumeCountMap.set(type, vols.size);
        }
      } catch { /* ignore */ }
    }

    // Select citation formatter based on case metadata
    let caseData: { jurisdiction?: string | null; state?: string | null; country?: string | null; caseNumber?: string | null } | null = null;
    if (caseId) {
      caseData = await context.database.case.findUnique({
        where: { id: caseId },
        select: { jurisdiction: true, state: true, country: true, caseNumber: true },
      });
    }
    const formatter = getCitationFormatter({
      jurisdiction: caseData?.jurisdiction || undefined,
      state: caseData?.state || undefined,
      country: caseData?.country || undefined,
    });

    // Enrich results with document names, matches, and citations
    const enrichedResults = await Promise.all(
      limitedResults.map(async (result) => {
        const document = await context.database.document.findUnique({
          where: { id: result.metadata.documentId },
          select: { fileName: true, filing: true, case: true, documentType: true },
        });

        // Extract the matched text
        const match = result.text.match(regex);
        const matchedText = match ? match[0] : '';

        // Build citation (same logic as query-case-knowledge)
        const filingType = result.metadata.filingType
          || (document as any)?.filing?.filingType
          || document?.documentType
          || undefined;
        let volumeNumber: number | undefined = result.metadata.volumeNumber || (document as any)?.filing?.volumeNumber;
        if (!volumeNumber && document?.fileName) {
          const volMatch = document.fileName.match(/-VOL(\d+)/i);
          if (volMatch) volumeNumber = parseInt(volMatch[1], 10);
        }
        const caseNumber = result.metadata.caseNumber || (document as any)?.case?.caseNumber || caseData?.caseNumber;
        const totalVolumes = filingType ? (volumeCountMap.get(filingType) ?? 1) : 1;

        const citationInput: CitationInput = {
          filingType,
          volumeNumber,
          totalVolumes,
          caseNumber: caseNumber || undefined,
          pageNumber: result.metadata.pageNumber,
          fileName: document?.fileName,
        };

        // Line numbers for Reporter's Record: prefer stored metadata, fall back to detection
        if (filingType) {
          const ft = filingType.toLowerCase();
          if (ft.includes('reporter') || ft === 'rr') {
            if (result.metadata.startLine && result.metadata.endLine) {
              citationInput.lineStart = result.metadata.startLine;
              citationInput.lineEnd = result.metadata.endLine;
            } else {
              const lineRange = detectLineNumbers(result.text);
              citationInput.lineStart = lineRange.startLine;
              citationInput.lineEnd = lineRange.endLine;
            }
          }
        }

        const formatted = formatter.format(citationInput);

        return {
          text: result.text,
          document: document?.fileName || 'Unknown',
          page: result.metadata.pageNumber,
          match: matchedText,
          citation: formatted.full,
          citationShort: formatted.short,
          filingType,
          volumeNumber,
          caseNumber: caseNumber || undefined,
          filingSlug: (document as any)?.filing?.slug || undefined,
        };
      }),
    );

    context.logger.info('Pattern scan completed', {
      resultCount: enrichedResults.length,
      ftsKeywords: keywords,
      candidatesBeforeFilter: searchResults.length,
    });

    return { results: enrichedResults };
  }
}
