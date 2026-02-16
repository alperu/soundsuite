/**
 * LegalTextSplitter provides legal-aware recursive text splitting.
 *
 * It detects legal document structures (section headings, numbered paragraphs,
 * legal markers) and splits text along those boundaries before falling back
 * to sentence and token-count splitting.
 *
 * Split hierarchy:
 *   section headings → numbered paragraphs → sentence boundaries → token-count fallback
 *
 * Uses HuggingFace tokenizers (Rust native, async) to avoid blocking the event loop.
 *
 * Requirements: 5.1
 */

import { TextChunker, ChunkConfig, Chunk, PageText, Exhibit, SacContext } from './text-chunker';
import * as path from 'path';
import * as os from 'os';

/**
 * The type of structural element detected in the text.
 */
export type StructureType = 'section' | 'paragraph' | 'sentence' | 'fallback';

/**
 * Extended chunk metadata that includes the detected structure type.
 */
export interface LegalChunkMetadata {
  documentId: string;
  caseId: string;
  pageNumber: number;
  chunkIndex: number;
  isExhibit: boolean;
  exhibitPath?: string;
  structureType?: StructureType;
}

/**
 * A structural block detected in the text.
 */
interface StructuralBlock {
  type: StructureType;
  heading?: string;       // The section heading text (for section blocks)
  text: string;           // The full text of this block
  startIndex: number;     // Character offset in the original text
}

// ── Pattern constants ──────────────────────────────────────────────

/** Matches section headings: "SECTION 1", "Article II", "WHEREAS", all-caps lines, etc. */
const SECTION_HEADING_RE =
  /^(?:SECTION\s+\d+|ARTICLE\s+[IVXLCDM\d]+|WHEREAS|WHEREFORE|NOW,?\s+THEREFORE|PART\s+[IVXLCDM\d]+|CHAPTER\s+\d+)[.:)]*\s*/i;

/** Matches legal document markers (standalone lines). */
const LEGAL_MARKER_RE =
  /^(?:ORDER|MOTION|NOTICE|FINDINGS?\s+OF\s+FACT|CONCLUSIONS?\s+OF\s+LAW|DECREE|JUDGMENT|STIPULATION|AFFIDAVIT|DECLARATION|PETITION|COMPLAINT|ANSWER|BRIEF|MEMORANDUM|EXHIBIT)\b/i;

/** Matches all-caps lines that are likely headings (≥3 chars, no lowercase). */
const ALL_CAPS_LINE_RE = /^[A-Z][A-Z\s\d.,;:'"()\-]{2,}$/;

/** Matches numbered paragraph starts: "1.", "1.1", "(a)", "(i)", "(1)", "a.", "A." */
const NUMBERED_PARA_RE =
  /^(?:\d+(?:\.\d+)*\.?\s|\([a-zA-Z0-9ivxlcdm]+\)\s|[a-zA-Z][\.\)]\s)/;


// ── Structure detection helpers ────────────────────────────────────

/**
 * Detect whether a line is a section heading.
 */
export function isSectionHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (SECTION_HEADING_RE.test(trimmed)) return true;
  if (LEGAL_MARKER_RE.test(trimmed)) return true;
  if (ALL_CAPS_LINE_RE.test(trimmed) && trimmed.length >= 3) return true;
  return false;
}

/**
 * Detect whether a line starts a numbered paragraph.
 */
export function isNumberedParagraph(line: string): boolean {
  return NUMBERED_PARA_RE.test(line.trim());
}

/**
 * Detect paragraph boundaries in text.
 * A paragraph boundary is a double newline or a significant indentation change.
 */
export function detectParagraphBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  const lines = text.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Double newline (empty line)
    if (line.trim() === '' && i > 0) {
      boundaries.push(offset);
    }
    offset += line.length + 1; // +1 for the newline character
  }

  return boundaries;
}

// ── Structural block parsing ───────────────────────────────────────

/**
 * Parse text into structural blocks (sections and paragraphs).
 */
function parseStructuralBlocks(text: string): StructuralBlock[] {
  const lines = text.split('\n');
  const blocks: StructuralBlock[] = [];
  let currentBlock: StructuralBlock | null = null;
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (isSectionHeading(trimmed)) {
      // Flush current block
      if (currentBlock && currentBlock.text.trim()) {
        blocks.push(currentBlock);
      }
      // Start a new section block
      currentBlock = {
        type: 'section',
        heading: trimmed,
        text: line,
        startIndex: offset,
      };
    } else if (isNumberedParagraph(trimmed)) {
      // Flush current block
      if (currentBlock && currentBlock.text.trim()) {
        blocks.push(currentBlock);
      }
      currentBlock = {
        type: 'paragraph',
        text: line,
        startIndex: offset,
      };
    } else if (trimmed === '' && currentBlock) {
      // Empty line — could be paragraph boundary
      // Append to current block; we'll split on double-newlines later if needed
      currentBlock.text += '\n' + line;
    } else {
      // Continuation of current block, or start of a new implicit paragraph
      if (!currentBlock) {
        currentBlock = {
          type: 'paragraph',
          text: line,
          startIndex: offset,
        };
      } else {
        currentBlock.text += '\n' + line;
      }
    }

    offset += line.length + 1;
  }

  // Flush last block
  if (currentBlock && currentBlock.text.trim()) {
    blocks.push(currentBlock);
  }

  return blocks;
}


// ── LegalTextSplitter class ────────────────────────────────────────

/**
 * LegalTextSplitter wraps TextChunker and adds legal-boundary-aware
 * recursive splitting.
 *
 * Split hierarchy:
 *   1. Section headings → start a new chunk
 *   2. Numbered paragraphs → keep whole if they fit
 *   3. Sentence boundaries → split within paragraphs
 *   4. Token-count fallback → hard split at token limit
 *
 * The parent section heading is prepended as context to child chunks.
 */
export class LegalTextSplitter {
  private chunker: TextChunker;
  private config: ChunkConfig;
  private hfTokenizer: any = null;
  private initPromise: Promise<void> | null = null;

  constructor(config: ChunkConfig = { chunkSize: 512, overlapSize: 50, tokenizer: 'huggingface' }) {
    this.config = config;
    this.chunker = new TextChunker(config);
  }

  /**
   * Initialize the HuggingFace tokenizer (lazy, once)
   */
  private async ensureInitialized(): Promise<void> {
    if (this.config.tokenizer !== 'huggingface') return;
    if (this.hfTokenizer) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      const modelName = (this.config as any).modelName || 'Xenova/all-MiniLM-L6-v2';
      const tokenizerPath = path.join(
        os.homedir(),
        '.cache',
        'transformers',
        modelName,
        'tokenizer.json'
      );
      try {
        const { Tokenizer } = await import('tokenizers');
        this.hfTokenizer = await Tokenizer.fromFile(tokenizerPath);
      } catch {
        // Fall back to simple if tokenizer file not found
        this.config.tokenizer = 'simple';
      }
    })();

    await this.initPromise;
  }

  /**
   * Count tokens using the HuggingFace tokenizer (async, non-blocking).
   * Falls back to simple character-based estimation.
   */
  private async countTokens(text: string): Promise<number> {
    if (this.config.tokenizer === 'huggingface' && this.hfTokenizer) {
      const encoded = await this.hfTokenizer.encode(text);
      return encoded.getLength();
    }
    // Simple fallback: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Split a single text block into sentences.
   */
  private splitIntoSentences(text: string): string[] {
    const sentences: string[] = [];
    const regex = /[^.!?]+[.!?]+/g;
    let match;
    let lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
      sentences.push(match[0]);
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      const remaining = text.slice(lastIndex).trim();
      if (remaining) sentences.push(remaining);
    }

    return sentences;
  }

  /**
   * Split text into chunks respecting sentence boundaries, with overlap.
   */
  private async splitBySentences(text: string, contextPrefix: string): Promise<string[]> {
    const sentences = this.splitIntoSentences(text);
    if (sentences.length === 0) return [];

    const prefixTokens = contextPrefix ? await this.countTokens(contextPrefix) : 0;
    const effectiveChunkSize = this.config.chunkSize - prefixTokens;

    const chunks: string[] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const sentence of sentences) {
      const sentenceTokens = await this.countTokens(sentence);

      if (currentTokens + sentenceTokens > effectiveChunkSize && current.length > 0) {
        const chunkText = contextPrefix
          ? contextPrefix + '\n' + current.join(' ')
          : current.join(' ');
        chunks.push(chunkText);

        // Build overlap from end of current
        const overlap: string[] = [];
        let overlapTokens = 0;
        for (let i = current.length - 1; i >= 0; i--) {
          const st = await this.countTokens(current[i]);
          if (overlapTokens + st <= this.config.overlapSize) {
            overlap.unshift(current[i]);
            overlapTokens += st;
          } else break;
        }
        current = overlap;
        currentTokens = overlapTokens;
      }

      current.push(sentence);
      currentTokens += sentenceTokens;
    }

    if (current.length > 0) {
      const chunkText = contextPrefix
        ? contextPrefix + '\n' + current.join(' ')
        : current.join(' ');
      chunks.push(chunkText);
    }

    return chunks;
  }

  /**
   * Hard-split text by token count when no sentence boundaries are available.
   */
  private async splitByTokenCount(text: string, contextPrefix: string): Promise<string[]> {
    const prefixTokens = contextPrefix ? await this.countTokens(contextPrefix) : 0;
    const effectiveSize = this.config.chunkSize - prefixTokens;
    if (effectiveSize <= 0) return [text];

    const words = text.split(/\s+/);
    const chunks: string[] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const word of words) {
      const wordTokens = await this.countTokens(word);
      if (currentTokens + wordTokens > effectiveSize && current.length > 0) {
        const chunkText = contextPrefix
          ? contextPrefix + '\n' + current.join(' ')
          : current.join(' ');
        chunks.push(chunkText);

        // Overlap
        const overlap: string[] = [];
        let overlapTokens = 0;
        for (let i = current.length - 1; i >= 0; i--) {
          const wt = await this.countTokens(current[i]);
          if (overlapTokens + wt <= this.config.overlapSize) {
            overlap.unshift(current[i]);
            overlapTokens += wt;
          } else break;
        }
        current = overlap;
        currentTokens = overlapTokens;
      }
      current.push(word);
      currentTokens += wordTokens;
    }

    if (current.length > 0) {
      const chunkText = contextPrefix
        ? contextPrefix + '\n' + current.join(' ')
        : current.join(' ');
      chunks.push(chunkText);
    }

    return chunks;
  }

  /**
   * Recursively split a structural block into chunks.
   */
  private async splitBlock(
    block: StructuralBlock,
    contextPrefix: string
  ): Promise<Array<{ text: string; structureType: StructureType }>> {
    const blockText = block.text.trim();
    if (!blockText) return [];

    const prefixTokens = contextPrefix ? await this.countTokens(contextPrefix) : 0;
    const blockTokens = await this.countTokens(blockText);
    const totalTokens = prefixTokens + blockTokens;

    // If the whole block fits in one chunk, return it as-is
    if (totalTokens <= this.config.chunkSize) {
      const text = contextPrefix
        ? contextPrefix + '\n' + blockText
        : blockText;
      return [{ text, structureType: block.type }];
    }

    // Block is too large — try splitting by sentences first
    const sentenceChunks = await this.splitBySentences(blockText, contextPrefix);
    if (sentenceChunks.length > 1) {
      return sentenceChunks.map(t => ({ text: t, structureType: 'sentence' as StructureType }));
    }

    // Sentence splitting didn't help (e.g. one giant sentence) — fall back to token count
    const tokenChunks = await this.splitByTokenCount(blockText, contextPrefix);
    return tokenChunks.map(t => ({ text: t, structureType: 'fallback' as StructureType }));
  }

  /**
   * Split page text using legal-aware recursive splitting.
   */
  async splitText(text: string): Promise<Array<{ text: string; structureType: StructureType }>> {
    if (!text || !text.trim()) return [];

    await this.ensureInitialized();

    const blocks = parseStructuralBlocks(text);
    if (blocks.length === 0) return [];

    const results: Array<{ text: string; structureType: StructureType }> = [];
    let currentSectionHeading = '';

    for (const block of blocks) {
      if (block.type === 'section') {
        currentSectionHeading = block.heading || block.text.trim().split('\n')[0];
        const splitResults = await this.splitBlock(block, '');
        results.push(...splitResults);
      } else {
        const splitResults = await this.splitBlock(block, currentSectionHeading);
        results.push(...splitResults);
      }
    }

    return results;
  }

  /**
   * Chunk pages of text into overlapping chunks with legal-aware splitting.
   * Drop-in replacement for TextChunker.chunkPages().
   */
  async chunkPages(
    pages: PageText[],
    documentId: string,
    caseId: string,
    _sacContext?: SacContext,
  ): Promise<Chunk[]> {
    await this.ensureInitialized();

    const chunks: Chunk[] = [];
    let globalChunkIndex = 0;

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const splitResults = await this.splitText(page.text);

      for (const result of splitResults) {
        const metadata: LegalChunkMetadata = {
          documentId,
          caseId,
          pageNumber: page.pageNumber,
          chunkIndex: globalChunkIndex++,
          isExhibit: false,
          structureType: result.structureType,
        };

        chunks.push({
          text: result.text,
          metadata,
        });
      }

      // Yield to event loop every 50 pages
      if ((i + 1) % 50 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return chunks;
  }

  /**
   * Chunk exhibit OCR text with exhibit-specific metadata.
   * Drop-in replacement for TextChunker.chunkExhibitText().
   */
  async chunkExhibitText(text: string, exhibit: Exhibit, _sacContext?: SacContext): Promise<Chunk[]> {
    await this.ensureInitialized();

    const splitResults = await this.splitText(text);
    const chunks: Chunk[] = [];

    for (let i = 0; i < splitResults.length; i++) {
      const metadata: LegalChunkMetadata = {
        documentId: exhibit.documentId,
        caseId: exhibit.caseId,
        pageNumber: exhibit.pageNumber,
        chunkIndex: i,
        isExhibit: true,
        exhibitPath: exhibit.imagePath,
        structureType: splitResults[i].structureType,
      };

      chunks.push({
        text: splitResults[i].text,
        metadata,
      });
    }

    return chunks;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.chunker.dispose();
    this.hfTokenizer = null;
  }
}
