/**
 * Backup API Route
 * 
 * POST /api/backup - Create a new backup
 * GET /api/backup - List available backups
 * PUT /api/backup - Restore from a backup
 * 
 * Requirements: 20.4, 20.5
 */

import { NextRequest, NextResponse } from 'next/server';
import { BackupManager } from '@/lib/backup';
import { logger } from '@/lib/logger';
import path from 'path';

// Default paths from environment or fallback to defaults
const DATABASE_PATH = process.env.DATABASE_URL?.replace('file:', '') || './data/sound-suite.db';
const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const BACKUP_DIR = process.env.BACKUP_DIR || './data/backups';

/**
 * POST /api/backup
 * Create a new backup of the system
 */
export async function POST(request: NextRequest) {
  try {
    logger.info('Backup API: Creating new backup');

    // Parse request body for options
    const body = await request.json().catch(() => ({}));
    const { includeLanceDB = true, includeDatabase = true } = body;

    // Create backup manager
    const backupManager = new BackupManager(DATABASE_PATH, LANCEDB_PATH);

    // Create backup
    const result = await backupManager.createBackup({
      outputDir: BACKUP_DIR,
      includeLanceDB,
      includeDatabase,
    });

    if (result.success) {
      logger.info(`Backup created successfully: ${result.backupDir}`);
      return NextResponse.json({
        success: true,
        message: 'Backup created successfully',
        backupDir: result.backupDir,
        manifestPath: result.manifestPath,
      });
    } else {
      logger.error(`Backup failed: ${result.error}`);
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Backup failed',
        },
        { status: 500 }
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Backup API error:', error);
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/backup
 * List available backups
 */
export async function GET() {
  try {
    logger.info('Backup API: Listing backups');

    // Create backup manager
    const backupManager = new BackupManager(DATABASE_PATH, LANCEDB_PATH);

    // List backups
    const backups = await backupManager.listBackups(BACKUP_DIR);

    return NextResponse.json({
      success: true,
      backups,
      backupDir: BACKUP_DIR,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Backup API error:', error);
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/backup
 * Restore system from a backup
 */
export async function PUT(request: NextRequest) {
  try {
    logger.info('Backup API: Restoring from backup');

    // Parse request body for options
    const body = await request.json();
    const { 
      backupDir, 
      restoreDatabase = true, 
      restoreLanceDB = true,
      verifyIntegrity = true 
    } = body;

    if (!backupDir) {
      return NextResponse.json(
        {
          success: false,
          error: 'backupDir is required',
        },
        { status: 400 }
      );
    }

    // Create backup manager
    const backupManager = new BackupManager(DATABASE_PATH, LANCEDB_PATH);

    // Restore backup
    const result = await backupManager.restoreBackup({
      backupDir,
      restoreDatabase,
      restoreLanceDB,
      verifyIntegrity,
    });

    if (result.success) {
      logger.info(`Restore completed successfully from ${backupDir}`);
      return NextResponse.json({
        success: true,
        message: 'Restore completed successfully',
        restoredDatabase: result.restoredDatabase,
        restoredLanceDB: result.restoredLanceDB,
        integrityVerified: result.integrityVerified,
      });
    } else {
      logger.error(`Restore failed: ${result.error}`);
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Restore failed',
        },
        { status: 500 }
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Backup API error:', error);
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
