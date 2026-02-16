# Claude Embedding Provider

⚠️ **IMPORTANT LIMITATION**: Claude (Anthropic) does not currently provide a dedicated embeddings API. This provider is implemented as a placeholder that explains this limitation and suggests alternatives.

## Current Status

As of the latest Anthropic API release, Claude does not offer an embeddings endpoint similar to OpenAI's embedding models. The Claude API focuses on text generation and conversation, not vector embeddings.

## Why This Provider Exists

This provider is included in the Sound Suite codebase for:

1. **API Completeness**: Maintains consistency with the design specification
2. **Future Compatibility**: Ready to implement when/if Anthropic releases an embeddings API
3. **Clear Documentation**: Explains the limitation to users who might expect Claude embeddings
4. **Configuration Support**: Allows the system to recognize Claude as a provider option

## What Happens When You Use It

If you configure Sound Suite to use the Claude embedding provider, the system will throw a clear error message explaining:

- Claude does not provide embeddings
- Alternative providers you can use (OpenAI, transformers.js)
- How to reconfigure your system

## Recommended Alternatives

### Option 1: OpenAI Embedding Provider (Recommended for Quality)

**Advantages:**
- High-quality embeddings optimized for semantic search
- Fast cloud-based processing
- Multiple model options (small, large, ada-002)
- Well-documented and widely used

**Configuration:**
```bash
# .env file
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

**Use Case:** Best for production deployments where quality and speed are important.

### Option 2: Transformers.js Embedding Provider (Recommended for Privacy)

**Advantages:**
- Completely local, no API calls
- No cost per embedding
- Privacy-preserving (data never leaves your machine)
- No API key required

**Configuration:**
```bash
# .env file
EMBEDDING_PROVIDER=transformers
TRANSFORMERS_MODEL=Xenova/all-MiniLM-L6-v2
```

**Use Case:** Best for sensitive legal documents where data privacy is critical.

### Option 3: Hybrid Approach (Use Claude for Other Tasks)

You can still use Claude in your Sound Suite workflow:

**For Document Analysis:**
- Use Claude via the MCP server for document analysis
- Use Claude to generate summaries or extract insights
- Use Claude for question-answering over retrieved chunks

**For Embeddings:**
- Use OpenAI or transformers.js for vector search
- The embedding provider only affects search, not analysis

**Configuration:**
```bash
# .env file
EMBEDDING_PROVIDER=openai  # or transformers
OPENAI_API_KEY=sk-...

# Separately configure Claude for MCP tools
ANTHROPIC_API_KEY=sk-ant-...
```

## Supported Models (For Reference)

If Anthropic releases an embeddings API in the future, these models would be supported:

### claude-3-opus-20240229
- **Use Case**: Highest quality (if embeddings were available)
- **Best For**: Maximum accuracy applications

### claude-3-sonnet-20240229 (Default)
- **Use Case**: Balanced quality and speed
- **Best For**: General-purpose applications

### claude-3-haiku-20240307
- **Use Case**: Fastest processing
- **Best For**: High-volume applications

## Technical Implementation

The current implementation:

1. **Constructor**: Validates API key and model name (for future compatibility)
2. **embed() Method**: Throws a descriptive error with alternatives
3. **Helper Methods**: Includes retry logic and rate limiting (for future use)
4. **API Compatibility**: Implements the same interface as other providers

## Future Roadmap

If Anthropic releases an embeddings API, this provider will be updated to:

1. Use the official Anthropic embeddings endpoint
2. Support Claude-specific embedding models
3. Implement proper batching and rate limiting
4. Add comprehensive tests

## Comparison with Other Providers

### vs. OpenAI Embedding Provider

**OpenAI Advantages:**
- Actually provides embeddings (Claude doesn't)
- Proven quality for semantic search
- Multiple model options
- Extensive documentation

**Claude Advantages (Hypothetical):**
- If embeddings were available, might offer different quality characteristics
- Could integrate better with Claude's text generation models
- Might have different pricing structure

### vs. Transformers.js Embedding Provider

**Transformers.js Advantages:**
- Works today (Claude embeddings don't exist)
- Completely local and private
- No API costs
- No rate limits

**Claude Advantages (Hypothetical):**
- If embeddings were available, likely higher quality than local models
- Cloud-based processing (faster than local CPU)

## Frequently Asked Questions

### Q: When will Claude support embeddings?

A: Anthropic has not announced plans for an embeddings API. Check their official documentation and changelog for updates.

### Q: Can I use Claude for anything in Sound Suite?

A: Yes! You can use Claude via the MCP server for document analysis, question-answering, and other text generation tasks. Only the embedding/vector search component requires a different provider.

### Q: What if I already configured Claude as my embedding provider?

A: The system will show a clear error message when it tries to generate embeddings. Follow the error message instructions to switch to OpenAI or transformers.js.

### Q: Is there a workaround to use Claude for embeddings?

A: Not directly. You could theoretically:
1. Use Claude to generate semantic summaries of text chunks
2. Use another provider (OpenAI or transformers.js) to embed those summaries
3. Store the embeddings in LanceDB

However, this is complex and not recommended. It's simpler to use OpenAI or transformers.js directly.

### Q: Will this provider be removed from the codebase?

A: No. It serves as documentation and maintains API consistency. If Anthropic releases embeddings, we can quickly implement support.

## Error Messages

### "Anthropic API key is required"

This error occurs if you try to create a ClaudeEmbeddingProvider without an API key.

**Solution:** Provide a valid Anthropic API key (even though embeddings aren't available, the constructor validates the key for future compatibility).

### "Unsupported model: [model-name]"

This error occurs if you specify a model name that isn't in the supported list.

**Solution:** Use one of the supported model names:
- claude-3-opus-20240229
- claude-3-sonnet-20240229
- claude-3-haiku-20240307

### "Claude (Anthropic) does not currently provide a dedicated embeddings API"

This is the main error you'll see when trying to generate embeddings.

**Solution:** Switch to OpenAI or transformers.js as described in the error message.

## Configuration Example

Even though Claude embeddings don't work, here's how you would configure it (for documentation purposes):

```bash
# .env file
EMBEDDING_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_EMBEDDING_MODEL=claude-3-sonnet-20240229
```

When the system tries to generate embeddings, it will show a helpful error message.

## Testing

The provider includes tests that verify:

1. Constructor validates API key and model name
2. embed() method throws appropriate error
3. Helper methods are implemented for future use
4. API compatibility with other providers

```bash
# Run Claude provider tests
npm test -- claude-embedding-provider

# Run only unit tests
npm test -- claude-embedding-provider.test.ts
```

## Requirements

This implementation satisfies the following requirements:

- **5.2**: Defines interface for embedding generation (throws error explaining limitation)
- **5.3**: Supports Claude as a provider option (with clear error messaging)
- **18.4**: Recognizes Claude embedding models (for future compatibility)
- **18.7**: Requires Claude API key when Claude is selected

## Contributing

If you'd like to contribute a working implementation when Anthropic releases embeddings:

1. Update the `embedBatch()` method to call the Anthropic embeddings endpoint
2. Update model configurations with actual embedding dimensions
3. Add comprehensive tests with real API calls
4. Update this documentation

## Resources

- [Anthropic API Documentation](https://docs.anthropic.com/)
- [Anthropic Changelog](https://docs.anthropic.com/changelog)
- [Sound Suite Configuration Guide](../../docs/configuration.md)
- [OpenAI Embedding Provider](./OPENAI_PROVIDER.md)
- [Transformers.js Embedding Provider](./TRANSFORMERS_PROVIDER.md)

## License

This implementation is part of the Sound Suite project.
