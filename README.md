# Sound Suite

A local, self-hosted document intelligence platform designed for legal case management. The system monitors local directories for court documents (PDFs), processes them through a hybrid OCR/vector pipeline, exposes data via Model Context Protocol (MCP) for AI consumption, and provides a Next.js dashboard for viewing processing status and managing documents.

## Features

- **Automated Document Ingestion**: Monitors directories for new PDFs and processes them automatically
- **Hybrid OCR Pipeline**: Extracts text from PDFs with OCR fallback for low-density pages
- **Exhibit Extraction**: Automatically extracts and OCRs images from documents
- **Vector Search**: Semantic search powered by embeddings (local or API-based)
- **MCP Server**: Exposes document data to AI assistants via Model Context Protocol
- **Dashboard**: Web interface for monitoring processing and managing documents

## Tech Stack

- **Next.js 14** with App Router and TypeScript
- **Prisma** with SQLite for metadata storage
- **LanceDB** for vector embeddings (to be implemented)
- **pdfjs-dist** for PDF parsing
- **tesseract.js** for OCR
- **transformers.js** for local embeddings (or OpenAI/Claude APIs)

## Getting Started

### Prerequisites

- Node.js 20+ 
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Set up environment variables:

```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Initialize the database:

```bash
npx prisma generate
npx prisma migrate dev --name init
```

5. Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the dashboard.

## Project Structure

```
sound-suite/
├── src/
│   ├── app/              # Next.js App Router pages
│   ├── lib/              # Core libraries
│   │   ├── db/           # Prisma client
│   │   ├── ingestion/    # PDF processing pipeline
│   │   ├── mcp/          # MCP Server
│   │   └── vector/       # LanceDB client
│   └── services/         # Background services
├── prisma/               # Database schema
├── data/                 # SQLite database and LanceDB
└── public/
    └── exhibits/         # Extracted images
```

## Configuration

See `.env.example` for all available configuration options.

### Embedding Providers

Sound Suite supports three embedding providers:

1. **transformers.js** (default): Local embeddings, no API key required
2. **OpenAI**: Requires `OPENAI_API_KEY`
3. **Claude**: Requires `ANTHROPIC_API_KEY`

## Development

This project is under active development. See the implementation plan in `.kiro/specs/sound-suite/tasks.md` for the roadmap.

## License

MIT
