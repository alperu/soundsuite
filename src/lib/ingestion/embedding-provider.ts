/**
 * Abstract base class for embedding providers.
 *
 * This class defines the interface that all embedding providers must implement,
 * whether they use local models (transformers.js), OpenAI API, or Claude API.
 *
 * Requirements: 5.2, 5.3
 */

import { ChunkMetadata } from './text-chunker';

/**
 * Configuration for embedding providers
 */
export interface EmbeddingConfig {
  /** The embedding provider type */
  provider: 'transformers' | 'openai' | 'claude';
  /** The model name to use */
  model: string;
  /** API key for cloud providers (OpenAI, Claude) */
  apiKey?: string;
  /** Number of dimensions in the embedding vectors */
  dimensions?: number;
}

/**
 * Represents a text chunk with its embedding
 */
export interface EmbeddedChunk {
  /** The original text content */
  text: string;
  /** The embedding vector */
  embedding: number[];
  /** Metadata about the chunk */
  metadata: ChunkMetadata;
}

/**
 * Abstract base class for all embedding providers.
 * 
 * Embedding providers are responsible for converting text into vector embeddings
 * that can be used for semantic search. Different providers offer different
 * trade-offs between quality, speed, cost, and privacy.
 */
export abstract class EmbeddingProvider {
  /**
   * Generate embeddings for a batch of text strings.
   * 
   * This method should handle batching internally if the provider has limits
   * on batch size. It should also implement appropriate error handling and
   * retry logic for API-based providers.
   * 
   * @param texts - Array of text strings to embed
   * @returns Promise resolving to array of embedding vectors (one per input text)
   * @throws Error if embedding generation fails after retries
   */
  abstract embed(texts: string[]): Promise<number[][]>;

  /**
   * Get the dimensionality of embeddings produced by this provider.
   * 
   * The dimension count depends on the model being used:
   * - transformers.js all-MiniLM-L6-v2: 384 dimensions
   * - transformers.js all-mpnet-base-v2: 768 dimensions
   * - OpenAI text-embedding-3-small: 1536 dimensions
   * - OpenAI text-embedding-3-large: 3072 dimensions
   * - OpenAI text-embedding-ada-002: 1536 dimensions
   * - Claude models: varies by model
   * 
   * @returns The number of dimensions in the embedding vectors
   */
  abstract getDimensions(): number;

  /**
   * Get the list of available models for this provider.
   * 
   * Each provider supports different models with different characteristics:
   * - transformers.js: Local models that run on CPU
   * - OpenAI: Cloud-based models with various quality/cost trade-offs
   * - Claude: Cloud-based models optimized for different use cases
   * 
   * @returns Array of model names that can be used with this provider
   */
  abstract getAvailableModels(): string[];

  /**
   * Get the model name currently in use by this provider.
   *
   * @returns The model identifier string
   */
  abstract getModelName(): string;
}
