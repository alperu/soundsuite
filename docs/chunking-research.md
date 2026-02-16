# Text Chunking Research

## Current Implementation

We use two custom classes with no external chunking library:

1. **`TextChunker`** (`src/lib/ingestion/text-chunker.ts`) — paragraph-based splitting with sentence fallback. Uses HuggingFace `tokenizers` (Rust native, async) for token counting.
2. **`LegalTextSplitter`** (`src/lib/ingestion/legal-text-splitter.ts`) — wraps TextChunker, adds legal-aware structure detection (section headings, numbered paragraphs, legal markers like WHEREAS, ORDER, FINDINGS OF FACT). **This is what production uses** via `worker-init.ts`.

### Split hierarchy (LegalTextSplitter)
1. Section headings (SECTION, ARTICLE, WHEREAS, all-caps lines)
2. Numbered paragraphs (1., 1.1, (a), (i))
3. Sentence boundaries
4. Token-count fallback (hard split)

Section headings are prepended as context to child chunks.

### Tokenizer History
- **Before**: tiktoken (WASM, synchronous) — blocked the Node.js event loop on large documents (1,496-page PDF locked the UI for 55+ minutes at 98.9% CPU)
- **After**: `tokenizers` npm package (HuggingFace Rust native bindings, async `encode()`) — runs on Rust threads, doesn't block the event loop
- Falls back to simple estimation (`Math.ceil(text.length / 4)`) if tokenizer.json not found

---

## Available Libraries

### LangChain.js Text Splitters
- **Package**: `@langchain/textsplitters`
- **Key class**: `RecursiveCharacterTextSplitter`
- **How it works**: Splits by a hierarchy of separators (`\n\n` -> `\n` -> `. ` -> ` ` -> character). Configurable chunk size and overlap.
- **Also has**: `TokenTextSplitter`, `MarkdownTextSplitter`, `HTMLTextSplitter`, `LatexTextSplitter`
- **Pros**: Most popular, well-tested, large community, supports many document types
- **Cons**: No legal-specific awareness, adds LangChain as a dependency, generic separator hierarchy may not respect legal document structure
- **Verdict**: Closest to what our custom code does but without legal structure detection

### LlamaIndex.TS
- **Package**: `llamaindex`
- **Key classes**: `SentenceSplitter`, `SemanticSplitter`
- **SemanticSplitter**: Uses the embedding model to find natural topic boundaries — groups sentences that are semantically similar into the same chunk
- **Pros**: Semantic splitting produces the most coherent chunks for retrieval, SentenceSplitter is solid for basic use
- **Cons**: SemanticSplitter is slow (embeds every sentence to measure similarity), large dependency, `SemanticSplitter` is not fully ported to TS version yet
- **Verdict**: Heavy dependency for uncertain gains. TS version focuses on `SentenceSplitter` and `MarkdownNodeParser`.

### text-splitter (Rust)
- **Package**: `text-splitter` Rust crate ([crates.io](https://crates.io/crates/text-splitter), [GitHub](https://github.com/benbrandt/text-splitter))
- **Node.js bindings**: **DO NOT EXIST.** Only Rust and Python bindings available. The Python package is `semantic-text-splitter` on PyPI.
- **Performance benchmarks** (from crate's criterion benchmarks and user reports):

  | Splitter Type | Chunk Size | Throughput |
  |---|---|---|
  | Character-based | 64 tokens | 7 MB/s |
  | Character-based | 1,024 tokens | 92 MB/s |
  | Character-based | 16,384 tokens | 373 MB/s |
  | Markdown-aware | 1,024 tokens | 28 MB/s |
  | Token-based (tiktoken) | 1,024 tokens | 1 MB/s |

- **Critical finding — slower than LangChain for token-based splitting** ([Issue #223](https://github.com/benbrandt/text-splitter/issues/223)):

  | Splitter | Time (10M chars, 658K tokens) |
  |---|---|
  | LangChain `RecursiveCharacterTextSplitter` | **0.61 seconds** |
  | `text-splitter` (Python bindings) | **20.12 seconds** |
  | `text-splitter` v0.14.0 (after perf fix) | **9.99 seconds** |

  The Rust crate is 16-33x slower than LangChain for token-based splitting because it does more algorithmic work (Unicode segmentation, semantic boundary detection). Character-based splitting is fast, but token-based (what we need) is not.

- **Features**: Character/token/HuggingFace/tiktoken sizing, overlap, trim, markdown-aware, code-aware (tree-sitter), range-based capacity
- **To use from Node.js**: Would need custom napi-rs bindings or WASM compilation (significant effort)
- **Verdict**: No Node.js support, and actually slower than LangChain for token-based splitting. Not a viable option.

### semantic-chunking
- **Package**: `semantic-chunking` ([npm](https://www.npmjs.com/package/semantic-chunking), [GitHub](https://github.com/jparkerweb/semantic-chunking))
- **How it works**: Uses `@xenova/transformers` internally. Splits text into sentences, embeds each, computes pairwise cosine similarity, groups by threshold.
- **Config**: `similarityThreshold` (default 0.456), `maxTokenSize` (default 500), `numSimilaritySentencesLookahead` (default 2), supports quantized models (q4, q8, fp16, fp32)
- **Pros**: Chunks are topically coherent, simple `chunkit()` API, BYOM (bring your own model)
- **Cons**: Downloads its own model copy, requires embedding every sentence (extremely slow on large docs)
- **Verdict**: Only viable for short documents. Completely impractical for 1,000+ page legal filings.

### Chonkie
- **Package**: `chonkie` ([npm](https://www.npmjs.com/package/chonkie), [GitHub](https://github.com/chonkie-inc/chonkiejs))
- **Version**: 0.3.0 (TS port of Python Chonkie)
- **Has**: Token, Sentence, Recursive, Table chunkers
- **Semantic chunker**: NOT available in TS version yet — only via Chonkie Cloud API
- **Verdict**: Not useful for our case until semantic chunker is ported locally

### Unstructured
- **Package**: Python library with REST API (`unstructured-io`)
- **How it works**: Full document understanding — parses PDFs, understands tables, headers, lists, images natively. Outputs structured elements that can then be chunked.
- **Pros**: Best document understanding, handles complex layouts, tables, multi-column text
- **Cons**: Python (would need API server), heavy dependency, overkill for text-only chunking
- **Verdict**: Worth considering if we need better PDF structure understanding, but not for chunking alone

---

## Semantic Chunking Deep Dive

### How It Works

The breakpoint-based semantic chunking algorithm:

1. **Sentence segmentation** — split document into individual sentences
2. **Sentence embedding** — embed each sentence using a model like `all-MiniLM-L6-v2`
3. **Pairwise cosine similarity** — compute similarity between sentence N and N+1 (or sliding window of 2-3)
4. **Breakpoint detection** — split where similarity drops below threshold (topic shift)
5. **Recombination** — optionally merge adjacent small chunks up to max token limit

A clustering variant uses spectral/k-means clustering on all sentence embeddings to group related sentences, but this loses document ordering.

### Retrieval Quality: Published Benchmarks

The evidence is **mixed and less favorable than marketing claims suggest**:

**Vectara Paper (arXiv:2410.13070, October 2024)** — most rigorous study:

| Method | Document Retrieval F1@5 | Evidence Retrieval F1@5 |
|---|---|---|
| Fixed-size chunking | 43.79-93.58% | 8.66-47.11% |
| Breakpoint semantic | 36.27-92.23% | 8.16-47.08% |
| Clustering semantic | 35.70-93.18% | 8.50-46.87% |

**Conclusion**: Fixed-size chunking consistently matched or outperformed semantic chunking on realistic datasets. Semantic chunking only showed marginal gains on artificially stitched documents with diverse topics.

**Chroma Technical Report (July 2024)**:

| Method | Recall | Precision | IoU |
|---|---|---|---|
| `RecursiveCharacterTextSplitter` (200 tokens) | 88.1% | 7.0% | 6.9% |
| `ClusterSemanticChunker` (200 tokens) | 87.3% | 8.0% | 8.0% |
| `ClusterSemanticChunker` (400 tokens) | 91.3% | 4.5% | 4.5% |
| `LLMSemanticChunker` (GPT-4o) | 91.9% | 3.9% | 3.9% |

Gap between best semantic and best fixed-size: ~3% recall, ~1% precision. Chroma's practical recommendation was `RecursiveCharacterTextSplitter` at 200 tokens.

**Realistic improvement**: 0-5% recall, 0-2% precision over well-tuned fixed-size chunking. Claims of "70% accuracy boost" in blog posts compare against naive baselines (large fixed chunks, no overlap), not against well-tuned approaches.

### Performance Cost

**Embedding throughput for `all-MiniLM-L6-v2`:**

| Runtime | Throughput |
|---|---|
| `@xenova/transformers` (ONNX, CPU, our setup) | ~50-80 sentences/sec |
| Python sentence-transformers (CPU, batched) | ~200-500 sentences/sec |
| Python sentence-transformers (GPU) | ~14,000 sentences/sec |

**For a 1,500-page legal document (~50,000 sentences):**

| Runtime | Time |
|---|---|
| Our setup (@xenova/transformers CPU) | **10-17 minutes** |
| Python CPU | 1.5-4 minutes |
| Python GPU | ~4 seconds |

Compare: our current structural chunker runs in **< 1 second** for the same document. Semantic chunking would increase embedding calls by ~100x (from ~200 final chunks to ~50,000 individual sentences).

### Hybrid Approach: Structure-First, Semantic Refinement

The most practical approach if we ever want semantic splitting:

```
Pages -> Structural split (headings, numbered paragraphs, page breaks)
  -> If section < 512 tokens: keep as single chunk
  -> If section > 512 tokens: apply semantic splitting within section only
  -> Recombine tiny chunks with adjacent chunks up to max size
```

This limits embedding to oversized sections only. For a well-structured 1,500-page legal filing, maybe 10-20% of sections exceed 512 tokens. This cuts embedding calls from ~50,000 to ~5,000-10,000, bringing time down to **1-3 minutes** instead of 10-17.

### Is Semantic Splitting Worth It for Legal Documents?

**No, with one narrow exception.**

**Why not:**
- Legal documents have strong structural signals (numbered paragraphs, section headings, exhibit references) that are better splitting points than cosine similarity boundaries
- The **Legal Chunking study (IOS Press, FAIA 2024)** tested semantic chunking on GDPR text — none of the methods consistently produced high semantic relevance. Structural splitters already captured coherent units.
- **LegalBench-RAG benchmark** showed `RecursiveCharacterTextSplitter` performed reasonably well; main gains came from **Summary Augmented Chunking** (adding LLM-generated summaries as metadata) rather than changing the splitting algorithm
- 0-5% retrieval improvement does not justify 10-17 minutes of additional processing per large document

**The one exception — dense narrative sections:**
Dense "STATEMENT OF FACTS" sections in trial briefs where multiple topics flow together without clear paragraph boundaries. Semantic splitting within these already-identified structural sections could help, but they represent a small fraction of total document content.

---

## Recommendation

Our current custom `LegalTextSplitter` is the right approach because:

1. **Legal-specific structure detection** — no library provides this out of the box
2. **Performance is solved** — HuggingFace tokenizer (async Rust) + paragraph-based chunking eliminated the event loop blocking
3. **No unnecessary dependencies** — LangChain/LlamaIndex would add large dependency trees for functionality we've already built
4. **Published research supports this** — fixed-size/structural chunking matches or outperforms semantic chunking on real-world benchmarks

### Potential Future Improvements (Priority Order)

1. **Summary Augmented Chunking (SAC)** — prepend LLM-generated summary to each chunk during ingestion. The NLLP 2025 paper showed this improved legal RAG retrieval more than any splitting strategy change. One-time cost, no runtime impact.
2. **Batch tokenization** — HuggingFace tokenizers supports `encodeBatch()` — could tokenize all paragraphs in one call instead of one at a time
3. **Hybrid semantic splitting for exhibits** — exhibit OCR text is short and lacks structure. Semantic chunking would be fast and beneficial here.
4. **Hybrid semantic splitting for dense sections** — only apply to sections > 1024 tokens after structural splitting. Limits overhead to 1-3 minutes.

---

## GPU / Embedding Acceleration Research

### Current Setup

- **Model**: `all-MiniLM-L6-v2` (22.7M parameters, 384-dim embeddings)
- **Runtime**: `@xenova/transformers` v3.x (ONNX, CPU-only on macOS)
- **Batch size**: 10
- **Throughput**: ~50-80 sentences/sec (~200 chunks/sec for paragraph-level chunks)

### transformers.js v3 vs v4

| Feature | v3 (stable, 3.8.1) | v4 (preview, 4.0.0-next.3) |
|---|---|---|
| ONNX CPU | Yes | Yes |
| WebGPU (browser) | Yes | Yes |
| CoreML (macOS/iOS) | No | Yes (`device: 'coreml'`) |
| Metal (macOS GPU) | No | No (not directly) |
| CUDA (NVIDIA) | No | No (Node.js only has ONNX CPU) |

### CoreML on Apple Silicon (M-series)

**How it works**: transformers.js v4 can load CoreML-optimized `.mlmodelc` files and run them on Apple's Neural Engine (ANE) + GPU via the CoreML framework. Requires:

1. Upgrade to `@huggingface/transformers` v4 (package name changed from `@xenova/transformers`)
2. Use CoreML-exported model variants (available on HuggingFace Hub with `-coreml` suffix or via `optimum` export)
3. Pass `device: 'coreml'` when loading the model

### Realistic Speedup Expectations

**Important caveat**: Apple Neural Engine is optimized for large models (billions of parameters). For small models like `all-MiniLM-L6-v2` (22.7M params), the ANE overhead (data transfer, compilation) can negate the compute speedup.

| Scenario | Expected Speedup |
|---|---|
| all-MiniLM-L6-v2 on CoreML (M1/M2) | **1.5-3x** |
| all-MiniLM-L6-v2 on CoreML (M3/M4) | **2-4x** |
| Larger model (e.g., bge-base, 109M params) on CoreML | **3-8x** |
| Python sentence-transformers + MPS (Metal) | **5-10x** |
| Python sentence-transformers + CUDA (NVIDIA) | **50-100x** |

### For 4,000 Pages (~800-1,600 chunks at paragraph level)

| Approach | Estimated Time |
|---|---|
| Current (ONNX CPU, batch=10) | **2-5 minutes** |
| Increase batch size to 32-64 (no code change needed) | **1-3 minutes** |
| CoreML via transformers.js v4 | **30s-2 minutes** |
| CoreML + larger batch size | **20s-1 minute** |
| Python with MPS backend (if we added a Python service) | **10-30 seconds** |

### Recommendation

1. **Immediate win — increase batch size** from 10 to 32-64 in `TransformersEmbeddingProvider`. This requires no dependency changes and can cut embedding time by 30-50%.
2. **Medium-term — upgrade to transformers.js v4** when it reaches stable release. The `@huggingface/transformers` package is a drop-in replacement for `@xenova/transformers` with CoreML support. Expected 1.5-3x additional speedup.
3. **Not recommended — Python sidecar for embedding**. Would add significant deployment complexity for marginal gains over CoreML. Only justified if processing 10,000+ pages regularly.

### v4 Migration Path

```
npm install @huggingface/transformers@next  # v4 preview
```

```typescript
// Before (v3)
import { pipeline } from '@xenova/transformers';
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

// After (v4 with CoreML)
import { pipeline } from '@huggingface/transformers';
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
  device: 'coreml',
});
```

**Risks**: v4 is still in preview (breaking changes possible). CoreML model variants may need separate download/export. Test thoroughly before production use.

---

## Sources

- [Vectara: Is Semantic Chunking Worth the Computational Cost? (arXiv:2410.13070)](https://arxiv.org/abs/2410.13070)
- [Chroma: Evaluating Chunking Strategies for Retrieval](https://research.trychroma.com/evaluating-chunking)
- [Legal Chunking: Evaluating Methods for Legal Text Retrieval (IOS Press, FAIA 2024)](https://ebooks.iospress.nl/doi/10.3233/FAIA241255)
- [Semantic Augmented Chunking for Legal RAG (NLLP 2025, ACL Anthology)](https://aclanthology.org/2025.nllp-1.3.pdf)
- [LegalBench-RAG Benchmark (arXiv:2408.10343)](https://arxiv.org/abs/2408.10343)
- [S2 Chunking: Hybrid Spatial-Semantic Framework (arXiv)](https://arxiv.org/html/2501.05485v1)
- [text-splitter Rust crate (GitHub)](https://github.com/benbrandt/text-splitter)
- [text-splitter Performance Issue #223](https://github.com/benbrandt/text-splitter/issues/223)
- [semantic-chunking npm (GitHub)](https://github.com/jparkerweb/semantic-chunking)
- [Chonkie.js (GitHub)](https://github.com/chonkie-inc/chonkiejs)
- [Max-Min Semantic Chunking (Springer, 2025)](https://link.springer.com/article/10.1007/s10791-025-09638-7)
