/**
 * Ingestion pipeline components
 */

export { PDFParser } from './pdf-parser';
export type { PageText, ExtractedImage } from './pdf-parser';

export { OCREngine } from './ocr-engine';
export type { OCRConfig, OCRResult } from './ocr-engine';

export { ExhibitExtractor } from './exhibit-extractor';
export type { ExhibitMetadata, ExhibitExtractionResult } from './exhibit-extractor';

export { TextChunker } from './text-chunker';
export type { ITextChunker, ChunkConfig, ChunkMetadata, Chunk, Exhibit } from './text-chunker';
export { EmbeddingProvider } from './embedding-provider';
export type { EmbeddingConfig, EmbeddedChunk } from './embedding-provider';

export { TransformersEmbeddingProvider } from './transformers-embedding-provider';
export type { ProgressCallback } from './transformers-embedding-provider';

export { OpenAIEmbeddingProvider } from './openai-embedding-provider';

export { ClaudeEmbeddingProvider } from './claude-embedding-provider';

export { OllamaEmbeddingProvider } from './ollama-embedding-provider';

export { LangChainTextChunker } from './langchain-text-chunker';

export { DocumentSummarizer } from './document-summarizer';

export { IngestionPipeline } from './ingestion-pipeline';
export type { IngestionResult, IngestionPipelineConfig } from './ingestion-pipeline';
