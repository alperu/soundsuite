# Sound Suite

A local, self-hosted document intelligence platform for legal case management. Sound Suite monitors directories for court PDFs, processes them through a hybrid OCR and vector pipeline, exposes 14 analysis tools via Model Context Protocol (MCP) for AI-powered case research, and provides a full-featured Next.js dashboard for managing cases, searching documents, and drafting legal filings.

## Features

- **Automated Document Ingestion** — Monitors directories for new PDFs and processes them automatically with configurable concurrency and retry
- **Hybrid OCR Pipeline** — Extracts text from digital PDFs with automatic OCR fallback for scanned and low-density pages via tesseract.js
- **Exhibit Extraction** — Identifies and catalogs images (photos, charts, diagrams) embedded in court documents
- **Vector Search** — Semantic search across all case documents powered by LanceDB with support for local (Ollama, Transformers.js) and cloud (OpenAI, Anthropic) embedding providers
- **14 MCP Analysis Tools** — Contradiction detection, argument structure extraction, timeline reconstruction, citation analysis, entity extraction, privilege review, tone analysis, and more
- **AI-Powered Search** — Deep Search decomposes questions into sub-queries for comprehensive answers with citations
- **Draft Editor** — Full-featured rich text editor with ribbon toolbar, outline navigation, version history, and import/export for .docx and .pdf
- **AI Writing Assistant** — In-editor AI chat, context-aware suggestions, and auto-complete powered by Claude, GPT, or Ollama models
- **Document Workflows** — Structured templates for appeal briefs, motions, and responses with guided sections and citation formatting
- **Case Explorer** — Built-in PDF viewer with document tree, table of contents, and page navigation
- **Dashboard** — Real-time processing status, service health monitoring, and document management
- **100% Local** — All processing runs on your machine. Documents never leave your computer.

## Tech Stack

- **Next.js 14** with App Router and TypeScript
- **Prisma** with SQLite for metadata and case management
- **LanceDB** for vector embeddings and semantic search
- **pdfjs-dist** for PDF text extraction
- **tesseract.js** for OCR on scanned documents
- **sharp** for image processing and exhibit extraction
- **Ollama / Transformers.js** for local embedding generation (or OpenAI/Anthropic APIs)
- **Redis** for caching and search performance (optional)
- **Tailwind CSS** for the dashboard UI

## Getting Started

### Prerequisites

- Node.js 18+
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/alperu/soundsuite.git
cd soundsuite

# Install dependencies
npm install

# Generate the database client
npx prisma generate

# Build the application
npm run build

# Start all services
npm run svc:start
```

Open [http://localhost:3000](http://localhost:3000) to see the dashboard. The MCP server runs at [http://localhost:3001](http://localhost:3001).

The database is automatically created on first startup.

### Docker

```bash
docker build -t sound-suite .
docker run -d -p 3000:3000 -p 3001:3001 -v /path/to/cases:/data/cases sound-suite
```

## Project Structure

```
soundsuite/
├── src/
│   ├── app/                # Next.js App Router pages and API routes
│   ├── components/         # React components (dashboard, editor, search)
│   ├── lib/
│   │   ├── db/             # Prisma client
│   │   ├── ingestion/      # PDF processing pipeline (extraction, OCR, chunking, embedding)
│   │   ├── mcp/            # MCP server and 14 analysis tools
│   │   └── vector/         # LanceDB client and vector search
│   └── services/           # Background services (file watcher, job queue)
├── prisma/
│   ├── schema.prisma       # Database schema
│   └── data/               # SQLite database
├── data/
│   └── lancedb/            # Vector database
├── scripts/                # Service management scripts
└── public/
    └── exhibits/           # Extracted exhibit images
```

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `transformers` | `transformers`, `ollama`, `openai`, or `anthropic` |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Model name for the selected provider |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint |
| `MCP_AUTH_MODE` | `none` | MCP auth: `none`, `apikey`, or `oauth` |
| `JOB_CONCURRENCY` | `2` | Documents processed simultaneously |
| `OCR_ENABLED` | `true` | Enable OCR for scanned pages |

See `.env.example` for the full reference.

### Embedding Providers

| Provider | API Key Required | GPU Recommended | Notes |
|----------|-----------------|-----------------|-------|
| **Transformers.js** | No | No | Default. Runs locally via ONNX models |
| **Ollama** | No | Yes | Local GPU-accelerated. Install [Ollama](https://ollama.com) separately |
| **OpenAI** | `OPENAI_API_KEY` | N/A | Cloud-based. Text sent to OpenAI API |
| **Anthropic** | `ANTHROPIC_API_KEY` | N/A | Cloud-based. Text sent to Anthropic API |

### Connecting AI Clients

Add Sound Suite to your MCP client configuration:

```json
{
  "mcpServers": {
    "sound-suite": {
      "url": "http://localhost:3000/api/mcp/execute",
      "transport": "http"
    }
  }
}
```

Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible client.

## MCP Tools

Sound Suite exposes 14 analysis tools organized by category:

| Category | Tools |
|----------|-------|
| **Search** | `query_case_knowledge`, `scan_for_pattern`, `retrieve_exhibit`, `search_workflows` |
| **Contradiction** | `detect_contradictions`, `track_claim_evolution` |
| **Argument** | `extract_argument_structure`, `compare_argument_structures` |
| **Timeline** | `reconstruct_timeline`, `extract_obligations` |
| **Entity** | `extract_entities`, `analyze_citations` |
| **Review** | `detect_privilege`, `analyze_tone` |

Tools can be enabled/disabled individually from the MCP Explorer in the dashboard.

## Service Management

```bash
npm run svc:start          # Start all services (dev mode)
npm run svc:start:prod     # Start in production mode
npm run svc:stop           # Stop all services
npm run svc:restart        # Restart all services
npm run svc:health         # Check service health
npm run db:backup          # Backup databases
npm run db:restore         # Restore from backup
```

## Documentation

Full documentation is available at [soundsuite.ai/documentation](https://soundsuite.ai/documentation).

## License

[Polyform Noncommercial 1.0.0](LICENSE) — free for personal use, pro se litigants, law students, and academic research. Commercial use by legal professionals and firms requires a [commercial license](https://soundsuite.ai/pricing). See [LICENSE](LICENSE) for full terms.
