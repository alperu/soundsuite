/**
 * LangChainTextChunker wraps RecursiveCharacterTextSplitter from @langchain/textsplitters
 * with legal-aware separator hierarchy and section-heading context.
 *
 * Supports Summary Augmented Chunking (SAC): when a documentSummary is provided,
 * it is prepended to every chunk so the embedding captures document identity.
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { ITextChunker, Chunk, PageText, Exhibit, SacContext } from './text-chunker';
import { isSectionHeading } from './legal-text-splitter';

/**
 * Legal-aware separators ordered from strongest to weakest boundary.
 * Transcript markers (Q./A./THE COURT/etc.) precede generic boundaries so
 * Reporter's Record pages get split at speaker turns instead of falling
 * through to whitespace and emitting one chunk per page.
 */
const LEGAL_SEPARATORS = [
  '\n\nSECTION ',
  '\n\nARTICLE ',
  '\n\nWHEREAS',
  '\n\nORDER',
  '\n\nFINDINGS OF FACT',
  '\n\nCONCLUSIONS OF LAW',
  '\nTHE COURT',
  '\nTHE WITNESS',
  '\nBY MS. ',
  '\nBY MR. ',
  '\nMS. ',
  '\nMR. ',
  '\nQ. ',
  '\nA. ',
  '\nQ ',
  '\nA ',
  '\n\n',
  '\n',
  '. ',
  '? ',
  '! ',
  '; ',
  ' ',
  '',
];

/**
 * Hard ceiling for a single chunk's body text (sacPrefix excluded).
 * Any chunk exceeding this gets re-split with the aggressive splitter
 * below. Prevents the "one chunk per page" degenerate case observed on
 * OCR-heavy Reporter's Record transcripts.
 */
const HARD_MAX_CHUNK_CHARS = 1000;

interface LangChainTextChunkerConfig {
  chunkSize?: number;      // in tokens (default: 512)
  overlapSize?: number;    // in tokens (default: 50)
  charsPerToken?: number;  // conversion factor (default: 4)
}

/**
 * Pre-split text into section blocks based on heading detection.
 * Returns an array of { heading, body } where heading is the detected
 * section heading line and body is all text until the next heading.
 */
function splitIntoSections(text: string): Array<{ heading: string; body: string }> {
  const lines = text.split('\n');
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    if (isSectionHeading(line.trim()) && line.trim().length > 0) {
      // Flush previous section
      if (currentBody.length > 0 || currentHeading) {
        sections.push({
          heading: currentHeading,
          body: currentBody.join('\n'),
        });
      }
      currentHeading = line.trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  // Flush last section
  if (currentBody.length > 0 || currentHeading) {
    sections.push({
      heading: currentHeading,
      body: currentBody.join('\n'),
    });
  }

  return sections;
}

export class LangChainTextChunker implements ITextChunker {
  private splitter: RecursiveCharacterTextSplitter;
  private fallbackSplitter: RecursiveCharacterTextSplitter;
  private config: Required<LangChainTextChunkerConfig>;

  constructor(config: LangChainTextChunkerConfig = {}) {
    this.config = {
      chunkSize: config.chunkSize ?? 512,
      overlapSize: config.overlapSize ?? 50,
      charsPerToken: config.charsPerToken ?? 4,
    };

    // LangChain splitter works in characters, so convert token counts
    const chunkSizeChars = this.config.chunkSize * this.config.charsPerToken;
    const overlapChars = this.config.overlapSize * this.config.charsPerToken;

    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize: chunkSizeChars,
      chunkOverlap: overlapChars,
      separators: LEGAL_SEPARATORS,
    });

    // Aggressive secondary splitter used only when a chunk exceeds
    // HARD_MAX_CHUNK_CHARS. Forces sub-paragraph granularity with a
    // bare-bones separator chain so even OCR-poor transcript text gets
    // broken up rather than emitted as one giant chunk.
    this.fallbackSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: HARD_MAX_CHUNK_CHARS,
      chunkOverlap: Math.min(overlapChars, 100),
      separators: ['\n', '. ', '? ', '! ', '; ', ', ', ' ', ''],
    });
  }

  /**
   * Enforce HARD_MAX_CHUNK_CHARS. Any chunk over the cap is run through
   * the aggressive fallback splitter so OCR-poor transcript pages can't
   * emit one chunk per page.
   */
  private async enforceMaxChunkSize(chunks: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const chunk of chunks) {
      if (chunk.length <= HARD_MAX_CHUNK_CHARS) {
        out.push(chunk);
        continue;
      }
      const subChunks = await this.fallbackSplitter.splitText(chunk);
      out.push(...subChunks);
    }
    return out;
  }

  /**
   * Build the SAC prefix from document context (case name, filing type, summary).
   * This legal context is prepended to every chunk so the embedding captures
   * document identity and retrieval quality improves.
   */
  private buildSacPrefix(context?: SacContext): string {
    if (!context) return '';
    const parts: string[] = [];
    if (context.caseName) parts.push(`Case: ${context.caseName}`);
    if (context.filingType) parts.push(`Filing: ${context.filingType}`);
    if (context.documentSummary) parts.push(`Summary: ${context.documentSummary}`);
    if (parts.length === 0) return '';
    return `[${parts.join(' | ')}]\n\n`;
  }

  /**
   * Split text with section-heading context and optional SAC prefix.
   */
  private async splitTextWithContext(text: string, sacPrefix: string): Promise<string[]> {
    if (!text || !text.trim()) return [];

    const sections = splitIntoSections(text);

    // If no sections detected, just split the whole text
    if (sections.length === 0) {
      const chunks = await this.enforceMaxChunkSize(await this.splitter.splitText(text));
      return chunks.map(c => sacPrefix + c);
    }

    // If there's only one section with no heading, split normally
    if (sections.length === 1 && !sections[0].heading) {
      const chunks = await this.enforceMaxChunkSize(await this.splitter.splitText(text));
      return chunks.map(c => sacPrefix + c);
    }

    const allChunks: string[] = [];

    for (const section of sections) {
      const bodyText = section.body.trim();
      if (!bodyText && !section.heading) continue;

      // If the section is small enough, keep it as one chunk
      const fullSection = section.heading
        ? section.heading + '\n' + bodyText
        : bodyText;

      if (!bodyText) {
        // Heading-only section — include as its own chunk
        allChunks.push(sacPrefix + fullSection);
        continue;
      }

      // Split the body text, then enforce hard size cap
      const bodyChunks = await this.enforceMaxChunkSize(await this.splitter.splitText(bodyText));

      for (const chunk of bodyChunks) {
        // Prepend heading context to each child chunk
        const contextChunk = section.heading
          ? sacPrefix + section.heading + '\n' + chunk
          : sacPrefix + chunk;
        allChunks.push(contextChunk);
      }
    }

    return allChunks;
  }

  async chunkPages(
    pages: PageText[],
    documentId: string,
    caseId: string,
    sacContext?: SacContext,
  ): Promise<Chunk[]> {
    const sacPrefix = this.buildSacPrefix(sacContext);
    const chunks: Chunk[] = [];
    let globalChunkIndex = 0;

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageChunks = await this.splitTextWithContext(page.text, sacPrefix);

      for (const chunkText of pageChunks) {
        chunks.push({
          text: chunkText,
          metadata: {
            documentId,
            caseId,
            pageNumber: page.pageNumber,
            chunkIndex: globalChunkIndex++,
            isExhibit: false,
          },
        });
      }

      // Yield to event loop every 50 pages
      if ((i + 1) % 50 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return chunks;
  }

  async chunkExhibitText(
    text: string,
    exhibit: Exhibit,
    sacContext?: SacContext,
  ): Promise<Chunk[]> {
    const sacPrefix = this.buildSacPrefix(sacContext);
    const textChunks = await this.splitTextWithContext(text, sacPrefix);
    const chunks: Chunk[] = [];

    for (let i = 0; i < textChunks.length; i++) {
      chunks.push({
        text: textChunks[i],
        metadata: {
          documentId: exhibit.documentId,
          caseId: exhibit.caseId,
          pageNumber: exhibit.pageNumber,
          chunkIndex: i,
          isExhibit: true,
          exhibitPath: exhibit.imagePath,
        },
      });
    }

    return chunks;
  }

  dispose(): void {
    // No resources to clean up
  }
}
