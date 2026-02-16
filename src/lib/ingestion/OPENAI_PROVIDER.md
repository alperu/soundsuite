# OpenAI Embedding Provider

The OpenAI Embedding Provider uses OpenAI's cloud-based API to generate high-quality embeddings for text chunks. This provider requires an API key and internet connection but offers state-of-the-art embedding quality.

## Features

- **Multiple Models**: Supports three OpenAI embedding models with different quality/cost trade-offs
- **Automatic Batching**: Processes up to 100 chunks per batch for efficiency
- **Rate Limiting**: Respects OpenAI's rate limits with exponential backoff retry logic
- **Error Recovery**: Automatically retries on transient errors (rate limits, server errors)
- **Fast Fail**: Immediately fails on authentication errors without retrying

## Supported Models

### text-embedding-3-small (Default)
- **Dimensions**: 1536
- **Max Tokens**: 8191
- **Use Case**: Cost-effective, good quality for most applications
- **Best For**: General-purpose semantic search, large document collections

### text-embedding-3-large
- **Dimensions**: 3072
- **Max Tokens**: 8191
- **Use Case**: Highest quality embeddings
- **Best For**: Applications requiring maximum accuracy, smaller document collections

### text-embedding-ada-002 (Legacy)
- **Dimensions**: 1536
- **Max Tokens**: 8191
- **Use Case**: Legacy model for backward compatibility
- **Best For**: Existing applications using ada-002

## Usage

### Basic Usage

```typescript
import { OpenAIEmbeddingProvider } from './openai-embedding-provider';

// Create provider with default model (text-embedding-3-small)
const provider = new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY!);

// Generate embeddings
const texts = [
  'This is the first chunk of text.',
  'This is the second chunk of text.',
];

const embeddings = await provider.embed(texts);
console.log(`Generated ${embeddings.length} embeddings`);
console.log(`Each embedding has ${embeddings[0].length} dimensions`);
```

### Using a Specific Model

```typescript
// Use the large model for higher quality
const provider = new OpenAIEmbeddingProvider(
  process.env.OPENAI_API_KEY!,
  'text-embedding-3-large'
);

const embeddings = await provider.embed(texts);
console.log(`Dimensions: ${provider.getDimensions()}`); // 3072
```

### Handling Large Batches

The provider automatically batches requests to respect API limits:

```typescript
const provider = new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY!);

// Process 250 chunks (will be split into 3 batches: 100 + 100 + 50)
const chunks = Array.from({ length: 250 }, (_, i) => `Chunk ${i + 1}`);
const embeddings = await provider.embed(chunks);
```

### Error Handling

```typescript
try {
  const embeddings = await provider.embed(texts);
} catch (error) {
  if (error.message.includes('Invalid OpenAI API key')) {
    console.error('Please check your API key');
  } else if (error.message.includes('rate limit')) {
    console.error('Rate limit exceeded, please try again later');
  } else {
    console.error('Embedding generation failed:', error.message);
  }
}
```

## Configuration

### Environment Variables

```bash
# Required: OpenAI API key
OPENAI_API_KEY=sk-...

# Optional: Model selection (defaults to text-embedding-3-small)
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

### Retry Logic

The provider implements exponential backoff for retryable errors:

- **Max Retries**: 3 attempts
- **Backoff Schedule**: 1s, 2s, 4s
- **Retryable Errors**: Rate limits (429), server errors (5xx)
- **Non-Retryable Errors**: Authentication (401), bad requests (4xx)

### Rate Limiting

The provider respects OpenAI's rate limits:

- Checks for `Retry-After` header in rate limit responses
- Caps retry delay at 60 seconds maximum
- Automatically backs off on rate limit errors

## Performance Considerations

### Batch Size

The provider uses a batch size of 100 chunks per request, which is optimal for:
- Minimizing API calls
- Staying within token limits
- Balancing latency and throughput

### Cost Optimization

To minimize costs:
1. Use `text-embedding-3-small` for most applications (lower cost)
2. Only use `text-embedding-3-large` when quality is critical
3. Batch requests to reduce API overhead
4. Cache embeddings to avoid regenerating for the same text

### Latency

Typical latency per batch:
- **text-embedding-3-small**: ~200-500ms per 100 chunks
- **text-embedding-3-large**: ~300-700ms per 100 chunks

Network latency and API load can affect these numbers.

## Comparison with Other Providers

### vs. TransformersEmbeddingProvider (Local)

**OpenAI Advantages:**
- Higher quality embeddings
- Faster processing (cloud-based)
- No local model download required
- Lower memory usage

**OpenAI Disadvantages:**
- Requires API key and internet connection
- Costs money per API call
- Data sent to external service (privacy concern)
- Subject to rate limits

### vs. ClaudeEmbeddingProvider

**OpenAI Advantages:**
- More mature embedding models
- Better documentation and tooling
- More model options

**Claude Advantages:**
- May offer better quality for certain use cases
- Different pricing structure

## Troubleshooting

### "Invalid OpenAI API key"

- Verify your API key is correct
- Check that the key has not expired
- Ensure the key has access to embedding models

### "Rate limit exceeded"

- The provider will automatically retry with backoff
- If persistent, consider:
  - Upgrading your OpenAI plan
  - Reducing batch size
  - Adding delays between requests

### "Service unavailable"

- OpenAI API may be experiencing issues
- The provider will automatically retry
- Check OpenAI status page: https://status.openai.com/

### Slow Performance

- Check your internet connection
- Consider using a smaller model (text-embedding-3-small)
- Verify you're not hitting rate limits
- Monitor API latency in OpenAI dashboard

## Testing

The provider includes comprehensive unit and integration tests:

```bash
# Run all OpenAI provider tests
npm test -- openai-embedding-provider

# Run only unit tests
npm test -- openai-embedding-provider.test.ts

# Run only integration tests
npm test -- openai-embedding-provider.integration.test.ts
```

## Requirements

This implementation satisfies the following requirements:
- **5.2**: Generate vector embeddings using configured provider
- **5.3**: Support multiple embedding provider options
- **18.3**: Support OpenAI embedding models
- **18.6**: Require OpenAI API key when OpenAI is selected

## API Reference

### Constructor

```typescript
constructor(apiKey: string, modelName?: string)
```

Creates a new OpenAI embedding provider.

**Parameters:**
- `apiKey` (required): OpenAI API key
- `modelName` (optional): Model to use (default: 'text-embedding-3-small')

**Throws:**
- Error if API key is missing
- Error if model name is not supported

### Methods

#### `embed(texts: string[]): Promise<number[][]>`

Generate embeddings for an array of text strings.

**Parameters:**
- `texts`: Array of text strings to embed

**Returns:**
- Promise resolving to array of embedding vectors

**Throws:**
- Error if embedding generation fails after retries

#### `getDimensions(): number`

Get the dimensionality of embeddings produced by this provider.

**Returns:**
- Number of dimensions in the embedding vectors

#### `getAvailableModels(): string[]`

Get the list of available models for this provider.

**Returns:**
- Array of model names that can be used

#### `getMaxTokens(): number`

Get the maximum number of tokens supported by the model.

**Returns:**
- Maximum token count (8191 for all current models)

## License

This implementation is part of the Sound Suite project.
