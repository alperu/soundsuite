# Services

This directory contains background services for the Sound Suite system.

## FileWatcher

The `FileWatcher` service monitors specified directories for PDF files and automatically enqueues them for processing.

### Features

- **Automatic Detection**: Monitors directories for new and modified PDF files
- **Google Drive Compatible**: Uses polling mode for network drive compatibility
- **Duplicate Detection**: Computes SHA-256 hashes to skip duplicate files
- **PDF Filtering**: Only processes files with `.pdf` extension
- **Database Integration**: Creates Case and Document records automatically

### Usage

```typescript
import { FileWatcher } from './services';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const watcher = new FileWatcher(
  {
    watchPaths: [
      '/path/to/case1',
      '/path/to/case2',
    ],
    pollInterval: 5000, // Check every 5 seconds
    ignoreInitial: false, // Process existing files on startup
  },
  prisma
);

// Start monitoring
await watcher.start();

// Stop monitoring
await watcher.stop();

// Check status
const isRunning = watcher.isWatcherRunning();
```

### Configuration

The FileWatcher accepts the following configuration options:

- `watchPaths` (required): Array of directory paths to monitor
- `pollInterval` (optional): Polling interval in milliseconds (default: 5000)
- `ignoreInitial` (optional): Whether to ignore existing files on startup (default: false)

### Requirements Implemented

- **Requirement 1.1**: Monitors specified case directories
- **Requirement 1.2**: Detects new PDF files within 5 seconds
- **Requirement 1.3**: Detects file modifications and creates new processing jobs
- **Requirement 1.4**: Computes SHA-256 hash of file content
- **Requirement 1.5**: Skips processing for duplicate hashes
- **Requirement 1.6**: Filters for .pdf extension only

### Testing

Run the unit tests:

```bash
npm test -- src/services/__tests__/file-watcher.test.ts
```

Run the manual test script:

```bash
npx ts-node src/services/test-file-watcher.ts
```

### Implementation Details

#### File Detection

The FileWatcher uses `chokidar` with polling enabled for compatibility with network drives like Google Drive. When a file is detected:

1. Check if it's a PDF file (by extension)
2. Compute SHA-256 hash of the file content
3. Check if a document with this hash already exists
4. If not, create a new Document record with status QUEUED
5. Associate the document with the appropriate Case

#### Case Management

On startup, the FileWatcher ensures that Case records exist for all monitored directories. The case name is derived from the directory basename.

#### Error Handling

- File system errors are logged but don't stop the watcher
- Database errors are logged and the file is skipped
- The watcher can be restarted after errors

### Future Enhancements

- Add support for recursive directory monitoring
- Add file size limits
- Add support for other document formats (DOCX, etc.)
- Add metrics and monitoring
