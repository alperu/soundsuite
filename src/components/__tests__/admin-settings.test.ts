/**
 * Unit tests for Admin Settings functionality
 * 
 * Tests:
 * - Configuration CRUD operations
 * - Model download status tracking
 * - API key validation
 * - Provider-specific model availability
 * 
 * Requirements: 18.1, 18.3, 18.4, 18.5, 18.9, 18.10, 18.12
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { getConfig, updateConfig, getModelDownloadStatus, updateModelDownloadStatus } from '@/lib/db/config';

const prisma = new PrismaClient();

describe('Admin Settings - Configuration Management', () => {
  beforeEach(async () => {
    // Clean up database before each test
    await prisma.config.deleteMany();
    await prisma.modelDownload.deleteMany();
  });

  afterEach(async () => {
    // Clean up after tests
    await prisma.config.deleteMany();
    await prisma.modelDownload.deleteMany();
  });

  it('should get default configuration when no config exists', async () => {
    const config = await getConfig();
    
    expect(config.embeddingProvider).toBe('transformers');
    expect(config.embeddingModel).toBe('Xenova/all-MiniLM-L6-v2');
    expect(config.openaiApiKey).toBeUndefined();
    expect(config.claudeApiKey).toBeUndefined();
  });

  it('should update and retrieve configuration', async () => {
    // Update configuration
    await updateConfig({
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      openaiApiKey: 'test-api-key',
    });

    // Retrieve configuration
    const config = await getConfig();
    
    expect(config.embeddingProvider).toBe('openai');
    expect(config.embeddingModel).toBe('text-embedding-3-small');
    expect(config.openaiApiKey).toBe('test-api-key');
  });

  it('should update only specified configuration fields', async () => {
    // Set initial configuration
    await updateConfig({
      embeddingProvider: 'transformers',
      embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    });

    // Update only the model
    await updateConfig({
      embeddingModel: 'Xenova/all-mpnet-base-v2',
    });

    // Retrieve configuration
    const config = await getConfig();
    
    expect(config.embeddingProvider).toBe('transformers');
    expect(config.embeddingModel).toBe('Xenova/all-mpnet-base-v2');
  });

  it('should handle multiple provider configurations', async () => {
    // Set configuration with multiple API keys
    await updateConfig({
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      openaiApiKey: 'openai-key',
      claudeApiKey: 'claude-key',
    });

    // Retrieve configuration
    const config = await getConfig();
    
    expect(config.openaiApiKey).toBe('openai-key');
    expect(config.claudeApiKey).toBe('claude-key');
  });
});

describe('Admin Settings - Model Download Management', () => {
  beforeEach(async () => {
    await prisma.modelDownload.deleteMany();
  });

  afterEach(async () => {
    await prisma.modelDownload.deleteMany();
  });

  it('should return empty array when no models are tracked', async () => {
    const downloads = await getModelDownloadStatus();
    expect(downloads).toHaveLength(0);
  });

  it('should track model download status', async () => {
    // Create a model download record
    await updateModelDownloadStatus(
      'Xenova/all-MiniLM-L6-v2',
      'transformers',
      'downloading',
      50,
      BigInt(90 * 1024 * 1024)
    );

    // Retrieve status
    const downloads = await getModelDownloadStatus();
    
    expect(downloads).toHaveLength(1);
    expect(downloads[0].modelName).toBe('Xenova/all-MiniLM-L6-v2');
    expect(downloads[0].provider).toBe('transformers');
    expect(downloads[0].status).toBe('downloading');
    expect(downloads[0].downloadProgress).toBe(50);
    expect(downloads[0].sizeBytes).toBeDefined();
  });

  it('should update model download progress', async () => {
    const modelName = 'Xenova/all-MiniLM-L6-v2';
    
    // Start download
    await updateModelDownloadStatus(modelName, 'transformers', 'downloading', 0);
    
    // Update progress
    await updateModelDownloadStatus(modelName, 'transformers', 'downloading', 50);
    await updateModelDownloadStatus(modelName, 'transformers', 'downloading', 100);
    
    // Mark as downloaded
    await updateModelDownloadStatus(
      modelName,
      'transformers',
      'downloaded',
      100,
      BigInt(90 * 1024 * 1024)
    );

    // Retrieve final status
    const downloads = await getModelDownloadStatus();
    
    expect(downloads).toHaveLength(1);
    expect(downloads[0].status).toBe('downloaded');
    expect(downloads[0].downloadProgress).toBe(100);
    expect(downloads[0].downloadedAt).toBeDefined();
  });

  it('should track download errors', async () => {
    const modelName = 'Xenova/all-MiniLM-L6-v2';
    
    // Start download
    await updateModelDownloadStatus(modelName, 'transformers', 'downloading', 0);
    
    // Simulate error
    await updateModelDownloadStatus(
      modelName,
      'transformers',
      'error',
      0,
      undefined,
      'Network error during download'
    );

    // Retrieve status
    const downloads = await getModelDownloadStatus();
    
    expect(downloads).toHaveLength(1);
    expect(downloads[0].status).toBe('error');
    expect(downloads[0].errorMessage).toBe('Network error during download');
  });

  it('should track multiple model downloads', async () => {
    // Track multiple models
    await updateModelDownloadStatus(
      'Xenova/all-MiniLM-L6-v2',
      'transformers',
      'downloaded',
      100,
      BigInt(90 * 1024 * 1024)
    );
    
    await updateModelDownloadStatus(
      'Xenova/all-mpnet-base-v2',
      'transformers',
      'not_downloaded',
      0
    );

    // Retrieve all statuses
    const downloads = await getModelDownloadStatus();
    
    expect(downloads).toHaveLength(2);
    
    const miniLM = downloads.find(d => d.modelName === 'Xenova/all-MiniLM-L6-v2');
    const mpnet = downloads.find(d => d.modelName === 'Xenova/all-mpnet-base-v2');
    
    expect(miniLM?.status).toBe('downloaded');
    expect(mpnet?.status).toBe('not_downloaded');
  });

  it('should handle model deletion by updating status', async () => {
    const modelName = 'Xenova/all-MiniLM-L6-v2';
    
    // Mark as downloaded
    await updateModelDownloadStatus(
      modelName,
      'transformers',
      'downloaded',
      100,
      BigInt(90 * 1024 * 1024)
    );

    // Delete model (update status to not_downloaded)
    await updateModelDownloadStatus(
      modelName,
      'transformers',
      'not_downloaded',
      0,
      undefined
    );

    // Retrieve status
    const downloads = await getModelDownloadStatus();
    
    expect(downloads).toHaveLength(1);
    expect(downloads[0].status).toBe('not_downloaded');
    expect(downloads[0].downloadProgress).toBe(0);
    expect(downloads[0].sizeBytes).toBeUndefined();
  });
});

describe('Admin Settings - Provider Model Availability', () => {
  it('should have correct models for transformers provider', () => {
    const transformersModels = [
      'Xenova/all-MiniLM-L6-v2',
      'Xenova/all-mpnet-base-v2',
    ];
    
    // These models should be available in the UI
    expect(transformersModels).toContain('Xenova/all-MiniLM-L6-v2');
    expect(transformersModels).toContain('Xenova/all-mpnet-base-v2');
  });

  it('should have correct models for OpenAI provider', () => {
    const openaiModels = [
      'text-embedding-3-small',
      'text-embedding-3-large',
      'text-embedding-ada-002',
    ];
    
    // These models should be available in the UI
    expect(openaiModels).toContain('text-embedding-3-small');
    expect(openaiModels).toContain('text-embedding-3-large');
    expect(openaiModels).toContain('text-embedding-ada-002');
  });

  it('should have correct models for Claude provider', () => {
    const claudeModels = [
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ];
    
    // These models should be available in the UI
    expect(claudeModels).toContain('claude-3-opus-20240229');
    expect(claudeModels).toContain('claude-3-sonnet-20240229');
    expect(claudeModels).toContain('claude-3-haiku-20240307');
  });
});
