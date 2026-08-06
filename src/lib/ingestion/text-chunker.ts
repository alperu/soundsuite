import * as path from 'path';
import * as os from 'os';

/**
 * Configuration for text chunking
 */
export interface ChunkConfig {
  chunkSize: number; // Tokens per chunk
  overlapSize: number; // Tokens of overlap between chunks
  tokenizer: 'huggingface' | 'simple';
  /** HuggingFace model name for tokenizer lookup (default: Xenova/all-MiniLM-L6-v2) */
  modelName?: string;
}

/**
 * Metadata for a text chunk
 */
export interface ChunkMetadata {
  documentId: string;
  caseId: string;
  pageNumber: number;
  chunkIndex: number;
  isExhibit: boolean;
  exhibitPath?: string;
  filingId?: string;
  filingType?: string;
  volumeNumber?: number;
  caseNumber?: string;
  documentType?: string;
  /** First transcript line number in this chunk (RR documents, 1-25) */
  startLine?: number;
  /** Last transcript line number in this chunk (RR documents, 1-25) */
  endLine?: number;
  /** JSON-encoded PageAnnotation[] for annotations overlapping this chunk */
  annotations?: string;
}

/**
 * A text chunk with metadata
 */
export interface Chunk {
  text: string;
  metadata: ChunkMetadata;
}

/**
 * Page text with page number
 */
export interface PageText {
  pageNumber: number;
  text: string;
  /** Structured blocks (PLAN-ss-docparse §0.1) — twin of the declaration in
   * pdf-parser.ts; keep BOTH in sync or the field is silently dropped. */
  blocks?: import('./docparse-types').DocparseBlock[];
  /** Metadata-only structure flag (PLAN-rr-structure item 5): when true the
   * StructuredChunker delegates this page to the legacy chunker despite
   * blocks being present (RR byte-identity). Twin of pdf-parser.ts. */
  structureOnly?: boolean;
}

/**
 * Exhibit information
 */
export interface Exhibit {
  pageNumber: number;
  imagePath: string;
  ocrText: string;
  documentId: string;
  caseId: string;
}

/**
 * Legal context for Summary Augmented Chunking (SAC).
 * Prepended to every chunk so the embedding captures document identity.
 */
export interface SacContext {
  caseName?: string;
  filingType?: string;
  documentSummary?: string;
}

/**
 * Interface for text chunkers.
 * Allows swapping implementations (TextChunker, LegalTextSplitter, LangChainTextChunker).
 */
export interface ITextChunker {
  chunkPages(pages: PageText[], documentId: string, caseId: string, sacContext?: SacContext): Promise<Chunk[]>;
  chunkExhibitText(text: string, exhibit: Exhibit, sacContext?: SacContext): Promise<Chunk[]>;
  dispose(): void;
}

/**
 * TextChunker splits text into overlapping chunks for vectorization.
 * Uses paragraph-based chunking with sentence fallback for oversized paragraphs.
 */
export class TextChunker {
  private config: ChunkConfig;
  private hfTokenizer: any = null;
  private initPromise: Promise<void> | null = null;

  constructor(config: ChunkConfig = { chunkSize: 512, overlapSize: 50, tokenizer: 'huggingface' }) {
    this.config = config;
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
      const modelName = this.config.modelName || 'Xenova/all-MiniLM-L6-v2';
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
   * Count tokens in text (async for HuggingFace, sync for simple)
   */
  private async countTokens(text: string): Promise<number> {
    switch (this.config.tokenizer) {
      case 'huggingface':
        if (!this.hfTokenizer) {
          return Math.ceil(text.length / 4);
        }
        const encoded = await this.hfTokenizer.encode(text);
        return encoded.getLength();

      case 'simple':
        return Math.ceil(text.length / 4);

      default:
        return Math.ceil(text.length / 4);
    }
  }

  /**
   * Split text into paragraphs
   */
  private splitIntoParagraphs(text: string): string[] {
    // Split on double newlines (paragraph boundaries)
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

    // If no paragraph breaks found, treat single newlines as breaks
    if (paragraphs.length <= 1 && text.length > 500) {
      return text.split(/\n/).map(p => p.trim()).filter(p => p.length > 0);
    }

    return paragraphs;
  }

  /**
   * Split text into sentences (fallback for oversized paragraphs)
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
      if (remaining) {
        sentences.push(remaining);
      }
    }

    return sentences.length > 0 ? sentences : [text];
  }

  /**
   * Create chunks from text using paragraph-based chunking.
   * Falls back to sentence splitting for paragraphs exceeding chunk size.
   */
  private async createChunksFromText(text: string): Promise<string[]> {
    const paragraphs = this.splitIntoParagraphs(text);
    const chunks: string[] = [];
    let currentChunk: string[] = [];
    let currentTokens = 0;

    for (const paragraph of paragraphs) {
      const paragraphTokens = await this.countTokens(paragraph);

      // If a single paragraph exceeds chunk size, split it by sentences
      if (paragraphTokens > this.config.chunkSize) {
        // Flush current chunk first
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.join('\n\n'));
          currentChunk = [];
          currentTokens = 0;
        }
        // Split oversized paragraph by sentences
        const sentenceChunks = await this.chunkBySentences(paragraph);
        chunks.push(...sentenceChunks);
        continue;
      }

      // If adding this paragraph would exceed chunk size
      if (currentTokens + paragraphTokens > this.config.chunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n\n'));

        // Overlap: keep last paragraph(s) from previous chunk
        const overlapChunk: string[] = [];
        let overlapTokens = 0;
        for (let i = currentChunk.length - 1; i >= 0; i--) {
          const overlapParaTokens = await this.countTokens(currentChunk[i]);
          if (overlapTokens + overlapParaTokens <= this.config.overlapSize) {
            overlapChunk.unshift(currentChunk[i]);
            overlapTokens += overlapParaTokens;
          } else {
            break;
          }
        }

        currentChunk = overlapChunk;
        currentTokens = overlapTokens;
      }

      currentChunk.push(paragraph);
      currentTokens += paragraphTokens;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n\n'));
    }

    return chunks;
  }

  /**
   * Sentence-level chunking fallback for oversized paragraphs
   */
  private async chunkBySentences(text: string): Promise<string[]> {
    const sentences = this.splitIntoSentences(text);
    const chunks: string[] = [];
    let currentChunk: string[] = [];
    let currentTokens = 0;

    for (const sentence of sentences) {
      const sentenceTokens = await this.countTokens(sentence);

      if (currentTokens + sentenceTokens > this.config.chunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.join(' '));

        // Overlap
        const overlapChunk: string[] = [];
        let overlapTokens = 0;
        for (let i = currentChunk.length - 1; i >= 0; i--) {
          const overlapSentTokens = await this.countTokens(currentChunk[i]);
          if (overlapTokens + overlapSentTokens <= this.config.overlapSize) {
            overlapChunk.unshift(currentChunk[i]);
            overlapTokens += overlapSentTokens;
          } else {
            break;
          }
        }

        currentChunk = overlapChunk;
        currentTokens = overlapTokens;
      }

      currentChunk.push(sentence);
      currentTokens += sentenceTokens;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join(' '));
    }

    return chunks;
  }

  /**
   * Chunk pages of text into overlapping chunks with metadata
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
      const pageChunks = await this.createChunksFromText(page.text);

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

  /**
   * Chunk exhibit OCR text with exhibit-specific metadata
   */
  async chunkExhibitText(text: string, exhibit: Exhibit, _sacContext?: SacContext): Promise<Chunk[]> {
    await this.ensureInitialized();

    const textChunks = await this.createChunksFromText(text);
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

  /**
   * Clean up resources
   */
  dispose(): void {
    this.hfTokenizer = null;
  }
}
