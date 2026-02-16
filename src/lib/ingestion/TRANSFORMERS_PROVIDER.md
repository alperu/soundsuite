# TransformersEmbeddingProvider

Local embedding generation using transformers.js for the Sound Suite system.

## Overview

The `TransformersEmbeddingProvider` implements the `EmbeddingProvider` interface to generate embeddings locally using the @xenova/transformers library. This provider runs entirely on the CPU without requiring external API calls, making it ideal for privacy-sensitive legal document processing.

## Features

- **Local Processing**: All embeddings are generated locally without external API calls
- **Model Management**: Download, delete, and check status of models
- **Batch Processing**: Automatically processes texts in batches of 100 for efficiency
- **Progress Tracking**: Optional progress callbacks for model downloads
- **Two Model Options**:
  - `Xenova/all-MiniLM-L6-v2` (384 dims, ~90MB) - Fast, good quality (default)
  - `Xenova/all-mpnet-base-v2` (768 dims, ~420MB) - Slower, better quality

## Usage

### Basic Usage

```typescript
import { TransformersEmbeddingProvider } from './transformers-embedding-provider';

// Create provider with default model
const provider = new TransformersEmbeddingProvider();

// Generate embeddings
const texts = ['Legal document text 1', 'Legal document text 2'];
const embeddings = await provider.embed(texts);

console.log(`Generated ${embeddings.length} embeddings`);
console.log(`Each embedding has ${embeddings[0].length} dimensions`);
```

### Using a Different Model

```typescript
// Use the larger, more accurate model
const provider = new TransformersEmbeddingProvider('Xenova/all-mpnet-base-v2');

const embeddings = await provider.embed(['Sample text']);
console.log(`Dimensions: ${provider.getDimensions()}`); // 768
```

### Model Management

```typescript
// Check if a model is downloaded
const isDownloaded = await TransformersEmbeddingProvider.isModelDownloaded(
  'Xenova/all-MiniLM-L6-v2'
);

// Download a model with progress tracking
await TransformersEmbeddingProvider.downloadModel(
  'Xenova/all-MiniLM-L6-v2',
  (progress, loaded, total) => {
    console.log(`Download progress: ${progress}% (${loaded}/${total} bytes)`);
  }
);

// Get the size of a downloaded model
const size = await TransformersEmbeddingProvider.getModelSize(
  'Xenova/all-MiniLM-L6-v2'
);
console.log(`Model size: ${(size / 1024 / 1024).toFixed(2)} MB`);

// Delete a model to free disk space
await TransformersEmbeddingProvider.deleteModel('Xenova/all-MiniLM-L6-v2');
```

### Get Available Models

```typescript
const provider = new TransformersEmbeddingProvider();
const models = provider.getAvailableModels();
console.log('Available models:', models);
// Output: ['Xenova/all-MiniLM-L6-v2', 'Xenova/all-mpnet-base-v2']
```

## Model Comparison

| Model | Dimensions | Size | Speed | Quality | Use Case |
|-------|-----------|------|-------|---------|----------|
| all-MiniLM-L6-v2 | 384 | ~90MB | Fast | Good | General purpose, quick processing |
| all-mpnet-base-v2 | 768 | ~420MB | Slower | Better | High-quality semantic search |

## Implementation Details

### Batching

The provider automatically processes texts in batches of 100 to avoid memory issues:

```typescript
// Internally handles batching
const texts = Array(250).fill('Sample text');
const embeddings = await provider.embed(texts);
// Processes as: 100 + 100 + 50
```

### Caching

Models are cached in `~/.cache/transformers/` and reused across sessions. The pipeline is initialized once and reused for all subsequent embedding requests.

### Normalization

All embeddings are normalized to unit length (L2 norm = 1.0) and use mean pooling for consistent semantic search results.

## Requirements Satisfied

- **Requirement 5.2**: Generate vector embeddings using configured provider
- **Requirement 5.3**: Support multiple embedding provider options
- **Requirement 18.5**: Support transformers.js models (all-MiniLM-L6-v2, all-mpnet-base-v2)
- **Requirement 18.8**: Run embeddings locally without external API calls
- **Requirement 18.12**: Display model download status
- **Requirement 18.13**: Provide download button for models
- **Requirement 18.15**: Update model status when download completes
- **Requirement 18.16**: Display model size and allow deletion

## Testing

Run the unit tests:

```bash
npm test -- transformers-embedding-provider.test.ts
```

Run the manual integration test:

```bash
npx ts-node src/lib/ingestion/test-transformers-provider.ts
```

## Error Handling

The provider includes comprehensive error handling:

- **Unsupported Model**: Throws error if model name is not in the supported list
- **Initialization Failure**: Throws error if pipeline cannot be created
- **Embedding Generation Failure**: Throws error with batch information
- **Model Management Errors**: Throws descriptive errors for download/delete/size operations

## Performance Considerations

- **First Run**: Model download may take several minutes depending on network speed
- **Subsequent Runs**: Models are cached locally for instant loading
- **CPU Usage**: Embedding generation is CPU-intensive; consider batch size for large datasets
- **Memory**: Each batch of 100 texts uses approximately 100-200MB of RAM

## Future Enhancements

Potential improvements for future versions:

- GPU acceleration support (if available)
- Additional model options (e.g., multilingual models)
- Configurable batch size
- Streaming progress for large batches
- Model quantization for smaller file sizes
