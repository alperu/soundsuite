# Backup Module

This module provides backup and restore functionality for Sound Suite data.

## Features

- **SQLite Database Export**: Backs up the complete SQLite database file
- **LanceDB Data Export**: Backs up the entire LanceDB vector database directory
- **Backup Manifest**: Creates a JSON manifest with metadata about each backup
- **Selective Backup**: Option to backup only database or only LanceDB
- **Backup Listing**: List all available backups with metadata

## Requirements

Validates: **Requirements 20.4** - System shall support exporting all data (SQLite + LanceDB) for backup

## Usage

### Creating a Backup

```typescript
import { BackupManager } from '@/lib/backup';

const backupManager = new BackupManager(
  './data/sound-suite.db',  // Database path
  './data/lancedb'          // LanceDB path
);

// Create a complete backup
const result = await backupManager.createBackup({
  outputDir: './data/backups',
  includeLanceDB: true,
  includeDatabase: true,
});

if (result.success) {
  console.log('Backup created:', result.backupDir);
  console.log('Manifest:', result.manifestPath);
} else {
  console.error('Backup failed:', result.error);
}
```

### Listing Backups

```typescript
const backups = await backupManager.listBackups('./data/backups');

backups.forEach(backup => {
  console.log('Backup:', backup.timestamp);
  console.log('Database size:', backup.databaseSize);
  console.log('LanceDB size:', backup.lancedbSize);
});
```

### API Endpoints

#### POST /api/backup

Create a new backup.

**Request Body:**
```json
{
  "includeLanceDB": true,
  "includeDatabase": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Backup created successfully",
  "backupDir": "/data/backups/backup-2024-01-01T12-00-00-000Z",
  "manifestPath": "/data/backups/backup-2024-01-01T12-00-00-000Z/manifest.json"
}
```

#### GET /api/backup

List all available backups.

**Response:**
```json
{
  "success": true,
  "backups": [
    {
      "version": "1.0.0",
      "timestamp": "2024-01-01T12:00:00.000Z",
      "databasePath": "./data/sound-suite.db",
      "lancedbPath": "./data/lancedb",
      "databaseSize": 1048576,
      "lancedbSize": 2097152
    }
  ],
  "backupDir": "./data/backups"
}
```

## Backup Structure

Each backup is stored in a timestamped directory:

```
backups/
└── backup-2024-01-01T12-00-00-000Z/
    ├── manifest.json          # Backup metadata
    ├── sound-suite.db          # SQLite database
    └── lancedb/               # LanceDB directory
        └── chunks/            # Vector tables
```

## Manifest Format

The `manifest.json` file contains metadata about the backup:

```json
{
  "version": "1.0.0",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "databasePath": "./data/sound-suite.db",
  "lancedbPath": "./data/lancedb",
  "databaseSize": 1048576,
  "lancedbSize": 2097152
}
```

## Error Handling

The backup manager handles various error scenarios:

- **Missing source files**: Creates empty files/directories and logs a warning
- **Permission errors**: Returns error result with descriptive message
- **Disk space issues**: Propagates error to caller
- **Invalid paths**: Returns error result

All errors are logged using the centralized logger.

## Testing

Unit tests are provided in `__tests__/backup-manager.test.ts`:

```bash
npm test -- src/lib/backup/__tests__/backup-manager.test.ts
```

API tests are provided in `src/app/api/backup/__tests__/backup.test.ts`:

```bash
npm test -- src/app/api/backup/__tests__/backup.test.ts
```

## Environment Variables

The backup API uses the following environment variables:

- `DATABASE_URL`: Path to SQLite database (default: `./data/sound-suite.db`)
- `LANCEDB_PATH`: Path to LanceDB directory (default: `./data/lancedb`)
- `BACKUP_DIR`: Path to backup storage directory (default: `./data/backups`)

## Future Enhancements

- Restore functionality (Task 22.2)
- Backup compression
- Incremental backups
- Backup encryption
- Automatic backup scheduling
- Backup retention policies
- Cloud backup integration
