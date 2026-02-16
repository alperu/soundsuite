# Sound Suite — Application Overview

**Sound Suite** (repo name: `court-lens-mcp`) is a self-hosted, local document intelligence platform purpose-built for legal case management. It automates the ingestion, OCR, indexing, and AI-powered analysis of court PDFs — all running on your own hardware with no data leaving your machine.

## What Problem It Solves

Legal professionals deal with massive volumes of court filings — motions, exhibits, reporter's records, correspondence. Sound Suite automates the entire lifecycle:

1. **Watches directories** (including Google Drive) for new PDF filings
2. **Extracts text** via pdfjs-dist, with OCR fallback for scanned/image-heavy pages
3. **Detects filing types** automatically (motion, exhibit, reporter's record, etc.)
4. **Chunks and embeds** text into vector representations for semantic search
5. **Exposes everything to AI** through the Model Context Protocol (MCP), so tools like Claude can query case knowledge directly

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), React, Tailwind CSS |
| Backend | Next.js API routes (port 3000) |
| Database | Prisma + SQLite (`prisma/data/sound-suite.db`) |
| Vector Store | LanceDB (`data/lancedb/`) |
| PDF Extraction | pdfjs-dist |
| OCR | tesseract.js (CPU) or Ollama (GPU) |
| Image Processing | sharp |
| Caching | Redis |
| GPU Orchestration | Sidecar Next.js app (port 8098) + Docker |
| AI Providers | Anthropic Claude, OpenAI, Ollama (local LLMs) |

## Core Data Flow

```
PDF on disk
  → FileWatcher (chokidar, 5s polling)
  → SHA-256 dedup → Document record (DISCOVERED)
  → User files it via UI → status: QUEUED
  → ParsingWorker claims it → status: PROCESSING
  → IngestionPipeline runs 14 stages:
      preflight → filing detection → text extraction → summarization
      → image scanning → exhibit detection → TOC extraction
      → exhibit OCR → fallback OCR → text chunking
      → embedding generation → vector indexing → verification
      → filing index
  → status: INDEXED (or ERROR)
  → Available for semantic search, pattern search, AI analysis, MCP tools
```

Documents have crash-resume checkpoints — if processing fails mid-way, it picks up where it left off.

### Ingestion Pipeline Stages

1. **Preflight** — file size and page count validation
2. **Filing detection** — regex + semantic classification of document type
3. **Text extraction** — pdfjs-dist (or layout-aware extraction for Reporter's Records)
4. **Document summarization** — generates SAC (Summary, Allegation, Claim) context
5. **Image scanning** — Poppler metadata analysis for embedded images
6. **Exhibit boundary detection** — regex patterns for "EXHIBIT A", etc.
7. **Table of contents extraction** — motion section parsing
8. **Exhibit extraction with OCR** — targeted image extraction and processing
9. **OCR fallback** — CPU/GPU OCR for low-density pages with image preprocessing
10. **Text chunking** — overlapping segments with SAC context prepended
11. **Embedding generation** — batched vector embedding via configured provider
12. **Vector indexing** — batched LanceDB insertion
13. **Verification** — page coverage checks
14. **Filing index building** — synthetic structural overview chunk

## Frontend Dashboard

The app provides a full web UI:

- **Case Management** (`/case-management`) — browse cases, view filings and exhibits in a hierarchical structure
- **Search** (`/search`) — semantic (vector), regex pattern, and AI-powered search modes
- **Admin** (`/admin`) — configure embedding providers, OCR settings, watch paths, GPU fleet, API keys, cache management
- **MCP Explorer** (`/mcp-explorer`) — test and configure MCP tools
- **Vector Store** (`/vectors`) — inspect indexed vectors and statistics
- **Exhibits** (`/exhibits`) — gallery view of extracted exhibit images
- **Workflows** (`/workflow`) — workflow builder with templates

## API Surface

The app exposes 60+ API routes organized by domain:

### Case & Document Management
- Cases — CRUD, file listing, filing queue, auto-filing, watch path configuration
- Documents — CRUD, PDF download, page images, page metadata, outline, reindex, status tracking

### Search
- `GET /api/search/semantic` — vector similarity search
- `POST /api/search/pattern` — regex pattern matching
- `GET /api/search/ai` — AI-powered analysis
- `GET /api/search/deep` — deep document analysis

### MCP Tools
- `POST /api/mcp/execute` — execute any MCP tool
- `GET /api/mcp/tools` — list available tools
- Tool-level configuration, rate limiting, health checks, and execution history

### Admin & Configuration
- System info, GPU fleet management, cache control, audit logs
- Embedding provider, OCR provider, watch paths, API keys
- Backup, Redis inspection, model downloads, file browsing

## MCP Integration (14 AI Tools)

The MCP server exposes tools that AI assistants (like Claude) can call directly:

| Tool | Purpose |
|------|---------|
| `query_case_knowledge` | Semantic vector search across documents |
| `scan_for_pattern` | Regex pattern matching |
| `retrieve_exhibit` | Find exhibit images by description |
| `detect_contradictions` | Find contradictory statements |
| `track_claim_evolution` | Timeline of how claims changed |
| `extract_argument_structure` | Parse legal arguments |
| `compare_argument_structures` | Compare two arguments |
| `reconstruct_timeline` | Build a case timeline |
| `extract_obligations` | Find contractual/legal obligations |
| `extract_entities` | Identify parties, dates, amounts |
| `analyze_citations` | Analyze legal citations (Texas RR line numbers) |
| `detect_privilege` | Identify attorney-client privilege |
| `analyze_tone` | Analyze emotional tone and rhetoric |
| `search_workflows` | Find relevant workflow templates |

Each tool has per-tool rate limiting, enable/disable toggles, and execution history tracking.

## GPU Sidecar

A separate Next.js app (`sideCar/`, port 8098) manages GPU resources:

- **Docker container lifecycle** — starts/stops GPU-accelerated OCR and embedding containers
- **Fleet routing** — dynamically routes OCR/embedding requests to available GPU sidecars
- **Min-online guarantees** — ensures minimum running instances per model
- **Peak demand tracking** — PID-controlled worker pool scaling
- **WebSocket communication** — real-time bidirectional updates with the main app

## Worker Pool & Processing

- **ParsingWorkerManager** spawns multiple workers that poll for QUEUED documents
- **WorkerPoolService** uses a PID controller to dynamically allocate workers between UI tasks (user-initiated) and background tasks (pre-caching)
- **BackgroundScannerDaemon** periodically scans directories for new files

### Caching Layers
- **Redis** — filing metadata and folder index caching (TTL-based)
- **In-memory** — OCR result cache (CachedOCREngine)
- **PageCache table** — per-page text cache for crash resume
- **PDF parser cache** — per-pipeline instance document cache

## Configuration

Three layers of configuration:

1. **`.env` file** — database URL, Redis, API keys, watch paths
2. **Config database table** — persisted key-value settings (Prisma)
3. **Admin UI** — real-time settings changes, synced to GPU sidecars

### Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | SQLite path (relative to `prisma/` dir) |
| `REDIS_URL` | Redis connection string |
| `WATCH_PATHS` | Directories to monitor for PDFs |
| `EMBEDDING_PROVIDER` | `transformers`, `openai`, `claude`, or `ollama` |
| `EMBEDDING_MODEL` | Model name for the selected provider |
| `OCR_PROVIDER` | `local` (tesseract.js) or `ollama` (GPU) |
| `MCP_AUTH_MODE` | `none`, `apikey`, or `oauth` |
| `WORKER_POOL_SIZE` | Number of parsing workers |
| `GPU_AUTO_MANAGE` | Enable fleet router for GPU sidecars |

## Key Database Models

| Model | Purpose |
|-------|---------|
| `Case` | Legal case linked to a directory path |
| `Document` | PDF file with processing status and hash dedup |
| `Filing` | Filing category within a case |
| `Motion` | Motions within a filing |
| `Exhibit` | Exhibits within a motion |
| `JobLog` | Batch processing run records |
| `PageCache` | Per-page text cache for crash resume |
| `Config` | Key-value configuration store |
| `ModelDownload` | Embedding model download tracking |
| `ActionLog` | Audit log of user actions |

Document status transitions: `DISCOVERED → QUEUED → PROCESSING → INDEXED` (or `ERROR` / `STOPPED`)
