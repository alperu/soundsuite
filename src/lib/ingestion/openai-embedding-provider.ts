/**
 * OpenAIEmbeddingProvider - Cloud-based embedding generation using OpenAI API
 * 
 * This provider uses the OpenAI API to generate embeddings using their
 * state-of-the-art embedding models. Requires an API key and internet connection.
 * 
 * Supported models:
 * - text-embedding-3-small (1536 dims) - Cost-effective, good quality
 * - text-embedding-3-large (3072 dims) - Highest quality
 * - text-embedding-ada-002 (1536 dims) - Legacy model
 * 
 * Requirements: 5.2, 5.3, 18.3, 18.6
 */

import OpenAI from 'openai';
import { EmbeddingProvider } from './embedding-provider';

/**
 * Model configuration mapping model names to their properties
 */
interface ModelConfig {
  name: string;
  dimensions: number;
  maxTokens: number;
}

/**
 * Available models for OpenAI embedding
 */
const AVAILABLE_MODELS: Record<string, ModelConfig> = {
  'text-embedding-3-small': {
    name: 'text-embedding-3-small',
    dimensions: 1536,
    maxTokens: 8191,
  },
  'text-embedding-3-large': {
    name: 'text-embedding-3-large',
    dimensions: 3072,
    maxTokens: 8191,
  },
  'text-embedding-ada-002': {
    name: 'text-embedding-ada-002',
    dimensions: 1536,
    maxTokens: 8191,
  },
};

/**
 * OpenAIEmbeddingProvider implementation using OpenAI API
 * 
 * This provider generates embeddings using OpenAI's cloud-based models.
 * It includes rate limiting, retry logic, and batching for efficient processing.
 */
export class OpenAIEmbeddingProvider extends EmbeddingProvider {
  private client: OpenAI;
  private modelName: string;
  private modelConfig: ModelConfig;
  private batchSize: number = 100;
  private maxRetries: number = 3;
  private baseDelay: number = 1000; // 1 second

  /**
   * Create a new OpenAIEmbeddingProvider
   * 
   * @param apiKey - OpenAI API key
   * @param modelName - The model to use (default: 'text-embedding-3-small')
   * @throws Error if the API key is missing or model name is not supported
   */
  constructor(apiKey: string, modelName: string = 'text-embedding-3-small') {
    super();

    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }

    if (!AVAILABLE_MODELS[modelName]) {
      throw new Error(
        `Unsupported model: ${modelName}. Available models: ${Object.keys(AVAILABLE_MODELS).join(', ')}`
      );
    }

    this.client = new OpenAI({ apiKey });
    this.modelName = modelName;
    this.modelConfig = AVAILABLE_MODELS[modelName];
  }

  /**
   * Generate embeddings for a batch of text strings with retry logic
   * 
   * @param texts - Array of text strings to embed
   * @returns Promise resolving to array of embedding vectors
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Process in batches to respect API limits
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchResults = await this.embedBatchWithRetry(batch);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Embed a single batch with exponential backoff retry logic
   * 
   * @param texts - Array of text strings to embed
   * @returns Promise resolving to array of embedding vectors
   */
  private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.embedBatch(texts);
      } catch (error: any) {
        lastError = error;

        // Check if error is retryable
        if (!this.isRetryableError(error)) {
          throw error;
        }

        // Calculate delay with exponential backoff
        const delay = this.calculateDelay(attempt, error);

        // Don't wait after the last attempt
        if (attempt < this.maxRetries - 1) {
          await this.sleep(delay);
        }
      }
    }

    throw new Error(
      `Failed to generate embeddings after ${this.maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Embed a single batch (no retry logic)
   * 
   * @param texts - Array of text strings to embed
   * @returns Promise resolving to array of embedding vectors
   */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.modelName,
        input: texts,
        encoding_format: 'float',
      });

      // Sort by index to ensure correct order
      const sortedData = response.data.sort((a, b) => a.index - b.index);

      // Extract embeddings
      return sortedData.map((item) => item.embedding);
    } catch (error: any) {
      // Enhance error message with context
      if (error.status === 401) {
        throw new Error('Invalid OpenAI API key');
      } else if (error.status === 429) {
        throw new Error('OpenAI API rate limit exceeded');
      } else if (error.status === 500 || error.status === 503) {
        throw new Error('OpenAI API service unavailable');
      } else {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
    }
  }

  /**
   * Check if an error is retryable
   * 
   * @param error - The error to check
   * @returns True if the error should trigger a retry
   */
  private isRetryableError(error: any): boolean {
    // Retry on rate limits (429) and server errors (5xx)
    if (error.message?.includes('rate limit')) {
      return true;
    }
    if (error.message?.includes('service unavailable')) {
      return true;
    }
    if (error.status >= 500 && error.status < 600) {
      return true;
    }
    if (error.status === 429) {
      return true;
    }
    return false;
  }

  /**
   * Calculate delay for exponential backoff
   * 
   * @param attempt - The current attempt number (0-indexed)
   * @param error - The error that triggered the retry
   * @returns Delay in milliseconds
   */
  private calculateDelay(attempt: number, error: any): number {
    // Check for Retry-After header (rate limit response)
    if (error.headers?.['retry-after']) {
      const retryAfter = parseInt(error.headers['retry-after'], 10);
      if (!isNaN(retryAfter)) {
        // Cap at 60 seconds
        return Math.min(retryAfter * 1000, 60000);
      }
    }

    // Exponential backoff: 1s, 2s, 4s
    return this.baseDelay * Math.pow(2, attempt);
  }

  /**
   * Sleep for a specified duration
   * 
   * @param ms - Duration in milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get the dimensionality of embeddings produced by this provider
   * 
   * @returns The number of dimensions in the embedding vectors
   */
  getDimensions(): number {
    return this.modelConfig.dimensions;
  }

  /**
   * Get the list of available models for this provider
   * 
   * @returns Array of model names that can be used
   */
  getAvailableModels(): string[] {
    return Object.keys(AVAILABLE_MODELS);
  }

  getModelName(): string {
    return this.modelName;
  }

  /**
   * Get the maximum number of tokens supported by the model
   *
   * @returns Maximum token count
   */
  getMaxTokens(): number {
    return this.modelConfig.maxTokens;
  }
}
