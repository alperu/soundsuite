# Ollama Setup Guide

Sound Suite uses Ollama for local, GPU-accelerated AI. Two models are needed:

- **llama3.3:70b** — completions (MCP tools, document summarization, AI search)
- **qwen3-embedding:0.6b** — embeddings (vector indexing for semantic search)

## Prerequisites

- Ollama installed on your GPU machine ([ollama.com/download](https://ollama.com/download))
- NVIDIA GPU with sufficient VRAM:
  - **llama3.3:70b** requires ~40GB VRAM (A6000 48GB recommended)
  - **qwen3-embedding:0.6b** requires ~1.2GB VRAM (any GPU)

## Install Models

```bash
# Completion model (for chat, analysis, summarization)
ollama pull llama3.3:70b

# Embedding model (for vector search — best for legal documents)
ollama pull qwen3-embedding:0.6b
```

Verify they're installed:

```bash
ollama list
```

## Expose Ollama to the Network

By default Ollama only listens on `localhost`. To allow Sound Suite (running on another machine) to connect:

### Linux

```bash
# Edit the systemd service
sudo systemctl edit ollama

# Add these lines:
[Service]
Environment="OLLAMA_HOST=0.0.0.0"

# Restart
sudo systemctl restart ollama
```

### Windows

Set the environment variable `OLLAMA_HOST=0.0.0.0` in System Properties > Environment Variables, then restart Ollama.

### macOS

```bash
launchctl setenv OLLAMA_HOST "0.0.0.0"
# Restart Ollama app
```

Verify it's accessible from your Sound Suite machine:

```bash
curl http://<ollama-machine-ip>:11434/api/tags
```

## Configure in Sound Suite

1. **Admin > AI Keys** — Set Ollama host URL: `http://<ollama-machine-ip>:11434`
2. **Admin > Embedding** — Select Ollama provider, pick `qwen3-embedding:0.6b`

## Embedding Model Comparison

Ranked by MLEB (Massive Legal Embedding Benchmark) — the legal document retrieval benchmark:

| Model | MLEB Score | Dims | Context | Size | Install Command |
|-------|-----------|------|---------|------|----------------|
| **qwen3-embedding:0.6b** | **76.4** | 768 | **32K** | 639MB | `ollama pull qwen3-embedding:0.6b` |
| qwen3-embedding:4b | **82.6** | 1024 | **40K** | 2.5GB | `ollama pull qwen3-embedding:4b` |
| snowflake-arctic-embed2 | 74.2 | 1024 | 8K | 1.2GB | `ollama pull snowflake-arctic-embed2` |
| bge-m3 | 72.2 | 1024 | 8K | 1.2GB | `ollama pull bge-m3` |
| nomic-embed-text | ~67 | 768 | 8K | 274MB | `ollama pull nomic-embed-text` |
| all-minilm | ~60 | 384 | 256 | 46MB | `ollama pull all-minilm` |

**Recommendation:** `qwen3-embedding:0.6b` is the best value — it scores higher than models 2x its size on legal benchmarks, has a 32K context window (ideal for long court filings), and only needs ~1.2GB RAM. If you have 5GB+ RAM to spare, `qwen3-embedding:4b` approaches proprietary model quality (MLEB 82.6).

**Why MLEB matters:** General embedding benchmarks (MTEB) don't predict legal retrieval quality. Models that rank #1 on MTEB can drop to #7 on MLEB. Qwen3 was specifically tested and performs exceptionally on US caselaw, contracts, and legal QA.

## Completion Model Reference

| Model | Purpose | VRAM | Install Command |
|-------|---------|------|----------------|
| `llama3.3:70b` | Completions (chat, analysis, SAC summaries) | ~40GB | `ollama pull llama3.3:70b` |

### Alternative Completion Models

If your GPU has less VRAM:

| Model | VRAM | Notes |
|-------|------|-------|
| `llama3.1:8b` | ~8GB | Smaller, faster, less capable |
| `qwen2.5:14b` | ~12GB | Good middle ground |
