/**
 * TransformersEmbeddingProvider - Local embedding generation using transformers.js
 * 
 * This provider uses the @xenova/transformers library to generate embeddings locally
 * without requiring external API calls. Models are downloaded once and cached locally.
 * 
 * Supported models:
 * - Xenova/all-MiniLM-L6-v2 (384 dims, ~90MB) - Fast, good quality
 * - Xenova/all-mpnet-base-v2 (768 dims, ~420MB) - Slower, better quality
 * 
 * Requirements: 5.2, 5.3, 18.5, 18.8, 18.12, 18.13, 18.15, 18.16
 */

import { pipeline, env } from '@xenova/transformers';
import { EmbeddingProvider } from './embedding-provider';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Model configuration mapping model names to their properties
 */
interface ModelConfig {
  name: string;
  dimensions: number;
  estimatedSize: number; // in bytes
}

/**
 * Available models for transformers.js embedding
 */
const AVAILABLE_MODELS: Record<string, ModelConfig> = {
  'Xenova/all-MiniLM-L6-v2': {
    name: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
    estimatedSize: 90 * 1024 * 1024, // ~90MB
  },
  'Xenova/all-mpnet-base-v2': {
    name: 'Xenova/all-mpnet-base-v2',
    dimensions: 768,
    estimatedSize: 420 * 1024 * 1024, // ~420MB
  },
};

/**
 * Progress callback for model downloads
 */
export type ProgressCallback = (progress: number, loaded: number, total: number) => void;

/**
 * TransformersEmbeddingProvider implementation using @xenova/transformers
 * 
 * This provider generates embeddings locally using transformer models that run on CPU.
 * Models are automatically downloaded and cached on first use.
 */
export class TransformersEmbeddingProvider extends EmbeddingProvider {
  private modelName: string;
  private modelConfig: ModelConfig;
  private pipeline: any | null = null;
  private initPromise: Promise<void> | null = null;
  private batchSize: number = 10;

  /**
   * Create a new TransformersEmbeddingProvider
   * 
   * @param modelName - The model to use (default: 'Xenova/all-MiniLM-L6-v2')
   * @throws Error if the model name is not supported
   */
  constructor(modelName: string = 'Xenova/all-MiniLM-L6-v2') {
    super();
    
    if (!AVAILABLE_MODELS[modelName]) {
      throw new Error(
        `Unsupported model: ${modelName}. Available models: ${Object.keys(AVAILABLE_MODELS).join(', ')}`
      );
    }
    
    this.modelName = modelName;
    this.modelConfig = AVAILABLE_MODELS[modelName];
    
    // Configure transformers.js to use local cache
    env.cacheDir = path.join(os.homedir(), '.cache', 'transformers');
  }

  /**
   * Initialize the embedding pipeline
   * This is called automatically on first use
   */
  private async initialize(): Promise<void> {
    if (this.pipeline) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        // Create the feature extraction pipeline
        this.pipeline = await pipeline('feature-extraction', this.modelName);
      } catch (error) {
        this.initPromise = null;
        throw new Error(`Failed to initialize embedding model ${this.modelName}: ${error}`);
      }
    })();

    return this.initPromise;
  }

  /**
   * Generate embeddings for a batch of text strings
   * 
   * @param texts - Array of text strings to embed
   * @returns Promise resolving to array of embedding vectors
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Initialize pipeline if needed
    await this.initialize();

    if (!this.pipeline) {
      throw new Error('Pipeline not initialized');
    }

    // Process in batches to avoid memory issues
    const results: number[][] = [];
    
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      
      try {
        // Generate embeddings for the batch
        const output = await this.pipeline(batch, {
          pooling: 'mean',
          normalize: true,
        });

        // Convert output to number arrays
        for (let j = 0; j < batch.length; j++) {
          const embedding = Array.from(output[j].data) as number[];
          results.push(embedding);
        }
      } catch (error) {
        throw new Error(`Failed to generate embeddings for batch ${i / this.batchSize + 1}: ${error}`);
      }
    }

    return results;
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

  /**
   * Get the model name currently in use
   */
  getModelName(): string {
    return this.modelName;
  }

  /**
   * Download a model with progress tracking
   * 
   * @param modelName - The model to download
   * @param onProgress - Optional callback for progress updates
   * @throws Error if the model name is not supported
   */
  static async downloadModel(
    modelName: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    if (!AVAILABLE_MODELS[modelName]) {
      throw new Error(
        `Unsupported model: ${modelName}. Available models: ${Object.keys(AVAILABLE_MODELS).join(', ')}`
      );
    }

    try {
      // Configure cache directory
      env.cacheDir = path.join(os.homedir(), '.cache', 'transformers');

      const estimatedSize = AVAILABLE_MODELS[modelName].estimatedSize;
      
      // Track progress if callback provided
      if (onProgress) {
        // Note: transformers.js doesn't provide built-in progress tracking
        // We'll simulate progress during initialization
        onProgress(0, 0, estimatedSize);
      }

      // Create a temporary provider to trigger download
      const provider = new TransformersEmbeddingProvider(modelName);
      
      // Start a progress simulation while downloading
      let progressInterval: NodeJS.Timeout | null = null;
      let currentProgress = 0;
      
      if (onProgress) {
        progressInterval = setInterval(() => {
          // Simulate progress up to 90% (we'll set 100% after completion)
          if (currentProgress < 90) {
            currentProgress += 10;
            const loaded = Math.floor((currentProgress / 100) * estimatedSize);
            onProgress(currentProgress, loaded, estimatedSize);
          }
        }, 500); // Update every 500ms
      }

      try {
        // Initialize the pipeline (this triggers download if needed)
        await provider.initialize();
      } finally {
        // Clear the progress interval
        if (progressInterval) {
          clearInterval(progressInterval);
        }
      }

      if (onProgress) {
        // Report 100% completion
        onProgress(100, estimatedSize, estimatedSize);
      }

    } catch (error) {
      throw new Error(`Failed to download model ${modelName}: ${error}`);
    }
  }

  /**
   * Delete a downloaded model to free disk space
   * 
   * @param modelName - The model to delete
   * @throws Error if the model name is not supported or deletion fails
   */
  static async deleteModel(modelName: string): Promise<void> {
    if (!AVAILABLE_MODELS[modelName]) {
      throw new Error(
        `Unsupported model: ${modelName}. Available models: ${Object.keys(AVAILABLE_MODELS).join(', ')}`
      );
    }

    try {
      const cacheDir = path.join(os.homedir(), '.cache', 'transformers');
      const modelPath = path.join(cacheDir, 'models', modelName);

      // Check if model directory exists
      try {
        await fs.access(modelPath);
      } catch {
        // Model not downloaded, nothing to delete
        return;
      }

      // Delete the model directory
      await fs.rm(modelPath, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`Failed to delete model ${modelName}: ${error}`);
    }
  }

  /**
   * Check if a model is already downloaded
   * 
   * @param modelName - The model to check
   * @returns Promise resolving to true if the model is downloaded
   * @throws Error if the model name is not supported
   */
  static async isModelDownloaded(modelName: string): Promise<boolean> {
    if (!AVAILABLE_MODELS[modelName]) {
      throw new Error(
        `Unsupported model: ${modelName}. Available models: ${Object.keys(AVAILABLE_MODELS).join(', ')}`
      );
    }

    try {
      const cacheDir = path.join(os.homedir(), '.cache', 'transformers');
      const modelPath = path.join(cacheDir, 'models', modelName);

      // Check if model directory exists
      await fs.access(modelPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the size of a downloaded model in bytes
   * 
   * @param modelName - The model to check
   * @returns Promise resolving to the size in bytes, or 0 if not downloaded
   * @throws Error if the model name is not supported
   */
  static async getModelSize(modelName: string): Promise<number> {
    if (!AVAILABLE_MODELS[modelName]) {
      throw new Error(
        `Unsupported model: ${modelName}. Available models: ${Object.keys(AVAILABLE_MODELS).join(', ')}`
      );
    }

    try {
      const cacheDir = path.join(os.homedir(), '.cache', 'transformers');
      const modelPath = path.join(cacheDir, 'models', modelName);

      // Check if model directory exists
      try {
        await fs.access(modelPath);
      } catch {
        // Model not downloaded
        return 0;
      }

      // Calculate total size of all files in the model directory
      let totalSize = 0;
      
      const calculateDirSize = async (dirPath: string): Promise<number> => {
        let size = 0;
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          
          if (entry.isDirectory()) {
            size += await calculateDirSize(fullPath);
          } else {
            const stats = await fs.stat(fullPath);
            size += stats.size;
          }
        }
        
        return size;
      };

      totalSize = await calculateDirSize(modelPath);
      return totalSize;
    } catch (error) {
      throw new Error(`Failed to get model size for ${modelName}: ${error}`);
    }
  }

  /**
   * Get the estimated size of a model before download
   * 
   * @param modelName - The model to check
   * @returns The estimated size in bytes
   * @throws Error if the model name is not supported
   */
  static getEstimatedModelSize(modelName: string): number {
    if (!AVAILABLE_MODELS[modelName]) {
      throw new Error(
        `Unsupported model: ${modelName}. Available models: ${Object.keys(AVAILABLE_MODELS).join(', ')}`
      );
    }

    return AVAILABLE_MODELS[modelName].estimatedSize;
  }
}
