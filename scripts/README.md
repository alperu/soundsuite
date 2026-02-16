# Sound Suite Scripts

This directory contains utility scripts for managing the Sound Suite application.

## Available Scripts

### start.sh

Starts all Sound Suite services in the correct order.

**Usage:**
```bash
# Start in development mode (default)
./scripts/start.sh

# Start in production mode
./scripts/start.sh production
# or
./scripts/start.sh prod
```

**What it does:**
1. Checks if `.env` file exists
2. Verifies database exists and runs migrations if needed
3. Checks for existing running services
4. Starts the Next.js dashboard (which includes integrated services)
5. Logs all service PIDs to `.pids/` directory
6. Displays startup status and health check
7. In dev mode, tails the dashboard logs

**Services Started:**
- **Dashboard**: Next.js web interface (port 3000)
- **File Watcher**: Monitors directories for new PDFs (integrated)
- **Job Queue**: Manages document processing jobs (integrated)
- **MCP Server**: Exposes document search tools (port 3001)

**Logs:**
- Dashboard logs: `logs/dashboard.log`

**PIDs:**
- Dashboard PID: `.pids/dashboard.pid`

**Prerequisites:**
- Node.js and npm installed
- `.env` file configured (copy from `.env.example`)
- All dependencies installed (`npm install`)

**Notes:**
- The file watcher, job queue, and MCP server are integrated into the Next.js application
- They start automatically when the dashboard starts
- In development mode, the script will tail logs after startup (Ctrl+C to stop tailing, services continue running)
- Use `./scripts/stop.sh` to stop all services

### stop.sh

Stops all running Sound Suite services gracefully.

**Usage:**
```bash
./scripts/stop.sh
```

### restart.sh

Restarts all Sound Suite services (stops then starts).

**Usage:**
```bash
# Restart in development mode
./scripts/restart.sh

# Restart in production mode
./scripts/restart.sh production
```

### health-check.sh

Checks the health of all Sound Suite services and displays status with color-coded output.

**Usage:**
```bash
./scripts/health-check.sh
```

**What it checks:**
1. **Dashboard Service**: Checks if Next.js is running and responding
2. **MCP Server**: Verifies MCP server is accessible
3. **File Watcher**: Checks if file monitoring is active
4. **Job Queue**: Verifies job processing service and displays queue status
5. **Database (SQLite)**: Tests database connectivity and displays record counts
6. **LanceDB**: Checks vector database accessibility and displays table information

**Output:**
- Color-coded status for each service:
  - ✓ Green: Service is running normally
  - ⚠ Yellow: Service is stopped or status unknown
  - ✗ Red: Service has encountered an error
- Detailed information for each service (PIDs, queue status, record counts, etc.)
- Overall system health status: HEALTHY, DEGRADED, or UNHEALTHY
- Recommended actions if issues are detected

**Exit codes:**
- 0: All services are healthy
- 1: One or more services are down or degraded

**Example output:**
```
═══════════════════════════════════════════════════════════
  Sound Suite Health Check
═══════════════════════════════════════════════════════════

[INFO] Checking system health at 2024-01-15 10:30:45

━━━ Dashboard Service ━━━
✓ Dashboard: Running
  PID: 12345

━━━ MCP Server ━━━
✓ MCP Server: Running
  Responding on http://localhost:3001

━━━ File Watcher Service ━━━
✓ File Watcher: Running
  Integrated with dashboard

━━━ Job Queue Service ━━━
✓ Job Queue: Running
  Queue: 5 pending, 2 active

━━━ Database (SQLite) ━━━
✓ Database: Running
  Path: ./data/sound-suite.db | Cases: 4, Documents: 127

━━━ Vector Database (LanceDB) ━━━
✓ LanceDB: Running
  Path: ./data/lancedb | Tables: 1, Size: 2.3G

═══════════════════════════════════════════════════════════
  Health Summary
═══════════════════════════════════════════════════════════

[SUCCESS] All services are healthy!

System Status: HEALTHY
```

**Use cases:**
- Monitor system health after startup
- Verify all services are running before processing
- Troubleshoot service issues
- Include in monitoring/alerting scripts
- Run as part of deployment verification

### Test Scripts (test/)

Comprehensive test scripts for validating Sound Suite functionality.

#### test-ingestion.sh

Tests the PDF ingestion pipeline including text extraction, OCR, chunking, and embedding generation.

**Usage:**
```bash
./scripts/test/test-ingestion.sh
```

**Tests:**
- Database connectivity
- Sample PDF directory and file
- PDF text extraction
- Exhibit extraction
- Text chunking
- Embedding provider initialization

#### test-search.sh

Tests semantic and pattern search functionality.

**Usage:**
```bash
./scripts/test/test-search.sh
```

**Tests:**
- LanceDB connectivity
- Semantic search (vector similarity)
- Pattern search (regex)
- Hybrid search (vector + pattern)
- Case filtering
- Result ordering by similarity score

#### test-exhibits.sh

Tests exhibit extraction and retrieval functionality.

**Usage:**
```bash
./scripts/test/test-exhibits.sh
```

**Tests:**
- Exhibits directory structure
- Image extraction from PDFs
- OCR processing on exhibits
- Exhibit metadata storage in LanceDB
- Exhibit retrieval by description
- File naming convention compliance

#### test-mcp-tools.sh

Tests all MCP server tools with sample queries.

**Usage:**
```bash
./scripts/test/test-mcp-tools.sh
```

**Prerequisites:**
- MCP server must be running (start with `./scripts/start.sh`)

**Tests:**
- List available MCP tools
- query_case_knowledge tool
- scan_for_pattern tool
- retrieve_exhibit tool
- Invalid regex error handling
- Case filtering
- Result limit enforcement

#### test-auth.sh

Tests OAuth and API key authentication.

**Usage:**
```bash
./scripts/test/test-auth.sh
```

**Prerequisites:**
- MCP server must be running with authentication enabled

**Tests:**
- Unauthenticated request rejection
- API key authentication
- Invalid API key rejection
- Authentication configuration
- API key storage in database
- OAuth configuration (if enabled)

#### test-all.sh

Master test script that runs all test suites sequentially.

**Usage:**
```bash
./scripts/test/test-all.sh
```

**What it does:**
1. Runs test-ingestion.sh
2. Runs test-search.sh
3. Runs test-exhibits.sh
4. Runs test-mcp-tools.sh
5. Runs test-auth.sh
6. Provides comprehensive summary of all test results

**Exit codes:**
- 0: All tests passed
- 1: One or more tests failed

## Directory Structure

```
scripts/
├── README.md              # This file
├── start.sh              # Start all services
├── stop.sh               # Stop all services
├── restart.sh            # Restart all services
├── health-check.sh       # Check service health status
└── test/                 # Test scripts
    ├── test-ingestion.sh # Test PDF ingestion pipeline
    ├── test-search.sh    # Test search functionality
    ├── test-exhibits.sh  # Test exhibit extraction
    ├── test-mcp-tools.sh # Test MCP tools
    ├── test-auth.sh      # Test authentication
    └── test-all.sh       # Run all tests
```

## Environment Variables

The start script uses the following environment variables from `.env`:

- `DATABASE_URL`: SQLite database path
- `MCP_PORT`: MCP server port (default: 3001)
- `WATCH_PATHS`: Comma-separated list of directories to monitor
- `EMBEDDING_PROVIDER`: Embedding provider (transformers/openai/claude)
- `EMBEDDING_MODEL`: Model name for embeddings
- `OPENAI_API_KEY`: OpenAI API key (if using OpenAI provider)
- `ANTHROPIC_API_KEY`: Anthropic API key (if using Claude provider)
- `JOB_CONCURRENCY`: Number of concurrent processing jobs (default: 2)
- `JOB_MAX_RETRIES`: Maximum retry attempts for failed jobs (default: 3)

## Troubleshooting

### Services already running
If you see "Some services are already running", stop them first:
```bash
./scripts/stop.sh
```

### Database migration errors
If migrations fail, try resetting the database:
```bash
npx prisma migrate reset
```

### Port already in use
If port 3000 or 3001 is already in use, stop the conflicting process or change the port in `.env`.

### Permission denied
Make sure the script is executable:
```bash
chmod +x scripts/start.sh
```

## Development

When developing new scripts:
1. Add proper error handling with `set -e`
2. Use colored output functions (print_info, print_success, print_warning, print_error)
3. Create PID files in `.pids/` directory
4. Write logs to `logs/` directory
5. Add cleanup trap for graceful shutdown
6. Document the script in this README
