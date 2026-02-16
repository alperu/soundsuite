# Centralized Logger

The Sound Suite system uses a centralized logger for consistent error logging across all components. This logger provides structured logging with timestamps, stack traces, and log levels.

## Features

- **Structured Logging**: All log entries include timestamp, log level, component name, message, and optional metadata
- **Stack Traces**: Error logs automatically capture and display stack traces
- **Log Levels**: Support for DEBUG, INFO, WARN, and ERROR levels with filtering
- **Component Tracking**: Each logger is associated with a component name for traceability
- **Child Loggers**: Create child loggers with nested component names
- **Metadata Support**: Attach arbitrary metadata to log entries

## Usage

### Creating a Logger

```typescript
import { createLogger, LogLevel } from '../lib/logger';

// Create a logger for your component
const logger = createLogger('MyComponent');

// Create a logger with custom minimum log level
const debugLogger = createLogger('MyComponent', LogLevel.DEBUG);
```

### Logging Messages

```typescript
// Debug messages (only shown when log level is DEBUG)
logger.debug('Processing started', { itemCount: 10 });

// Info messages
logger.info('Document processed successfully', { documentId: '123' });

// Warning messages
logger.warn('Low disk space detected', { availableGB: 5 });

// Error messages with stack trace
try {
  // ... some operation
} catch (error) {
  logger.error('Failed to process document', error, { documentId: '123' });
}
```

### Child Loggers

Create child loggers to add context to nested operations:

```typescript
const parentLogger = createLogger('IngestionPipeline');
const childLogger = parentLogger.child('PDFParser');

// Logs will show [IngestionPipeline:PDFParser]
childLogger.info('Parsing PDF file');
```

## Log Entry Format

Each log entry includes:

```
[timestamp] [level] [component] message
```

Example:
```
[2024-01-15T10:30:45.123Z] [ERROR] [FileWatcher] Error handling file addition
  Error: File not found
  Stack: Error: File not found
    at FileWatcher.onFileAdded (/path/to/file.ts:123:45)
    ...
```

## Log Levels

The logger supports four log levels in order of severity:

1. **DEBUG**: Detailed information for debugging (lowest priority)
2. **INFO**: General informational messages
3. **WARN**: Warning messages for potentially problematic situations
4. **ERROR**: Error messages with stack traces (highest priority)

Set the minimum log level when creating a logger to filter out lower-priority messages:

```typescript
// Only show ERROR messages
const logger = createLogger('MyComponent', LogLevel.ERROR);
```

## Components Using the Logger

The following components have been updated to use the centralized logger:

- **FileWatcher** (`src/services/file-watcher.ts`)
  - Logs file detection events
  - Logs errors during file processing
  - Logs case record creation

- **JobQueue** (`src/services/job-queue.ts`)
  - Logs job execution and retries
  - Logs job failures with full error details
  - Tracks job lifecycle events

- **IngestionPipeline** (`src/lib/ingestion/ingestion-pipeline.ts`)
  - Logs each stage of document processing
  - Logs errors with rollback information
  - Tracks processing duration and metrics

- **MCPServer** (`src/lib/mcp/mcp-server.ts`)
  - Logs server startup and shutdown
  - Logs authentication failures
  - Logs tool invocations and results
  - Logs errors during request handling

## Requirements

This logger implementation satisfies **Requirement 19.1**:

> WHEN any component encounters an error, THE Sound_Suite_System SHALL log the error with timestamp and stack trace

All error logs include:
- ISO 8601 timestamp
- Component name for traceability
- Error message
- Full stack trace (when available)
- Error code (when available)
- Optional metadata for context

## Testing

The logger is fully tested in `src/lib/__tests__/logger.test.ts` with coverage for:
- Log level filtering
- Error handling with stack traces
- Timestamp formatting
- Child logger creation
- Metadata attachment
- Non-Error object handling

Run tests with:
```bash
npm test -- src/lib/__tests__/logger.test.ts
```
