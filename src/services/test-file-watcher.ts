/**
 * Manual test script for FileWatcher
 * 
 * This script demonstrates the FileWatcher functionality:
 * 1. Creates a test directory
 * 2. Starts the FileWatcher
 * 3. Creates test PDF files
 * 4. Verifies documents are created in the database
 * 
 * Usage: npx ts-node src/services/test-file-watcher.ts
 */

import { FileWatcher } from './file-watcher';
import { PrismaClient } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

async function main() {
  const prisma = new PrismaClient();
  let tempDir: string | null = null;
  let watcher: FileWatcher | null = null;

  try {
    // Create a temporary test directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-watcher-manual-test-'));
    console.log(`\n📁 Created test directory: ${tempDir}\n`);

    // Initialize FileWatcher
    watcher = new FileWatcher(
      {
        watchPaths: [tempDir],
        ignoreInitial: true,
        pollInterval: 1000, // Check every second
      },
      prisma
    );

    // Start watching
    console.log('🔍 Starting FileWatcher...\n');
    await watcher.start();

    // Wait for watcher to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test 1: Create a PDF file
    console.log('📄 Test 1: Creating test.pdf...');
    const testPdf1 = path.join(tempDir, 'test.pdf');
    await fs.writeFile(testPdf1, 'This is a test PDF content');
    
    // Wait for detection
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    let documents = await prisma.document.findMany({
      where: {
        case: {
          path: tempDir,
        },
      },
    });
    
    console.log(`✅ Documents in database: ${documents.length}`);
    if (documents.length > 0) {
      console.log(`   - ${documents[0].fileName} (${documents[0].status})`);
    }

    // Test 2: Create a non-PDF file (should be ignored)
    console.log('\n📄 Test 2: Creating test.txt (should be ignored)...');
    const testTxt = path.join(tempDir, 'test.txt');
    await fs.writeFile(testTxt, 'This is a text file');
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    documents = await prisma.document.findMany({
      where: {
        case: {
          path: tempDir,
        },
      },
    });
    
    console.log(`✅ Documents in database: ${documents.length} (should still be 1)`);

    // Test 3: Create a duplicate PDF (same content)
    console.log('\n📄 Test 3: Creating duplicate.pdf with same content...');
    const testPdf2 = path.join(tempDir, 'duplicate.pdf');
    await fs.writeFile(testPdf2, 'This is a test PDF content'); // Same content as test.pdf
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    documents = await prisma.document.findMany({
      where: {
        case: {
          path: tempDir,
        },
      },
    });
    
    console.log(`✅ Documents in database: ${documents.length} (should still be 1 - duplicate skipped)`);

    // Test 4: Modify the original PDF
    console.log('\n📄 Test 4: Modifying test.pdf...');
    await fs.writeFile(testPdf1, 'This is modified PDF content');
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    documents = await prisma.document.findMany({
      where: {
        case: {
          path: tempDir,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
    
    console.log(`✅ Documents in database: ${documents.length} (should be 2 - original + modified)`);
    documents.forEach((doc, i) => {
      console.log(`   ${i + 1}. ${doc.fileName} (${doc.status}) - Hash: ${doc.hash.substring(0, 8)}...`);
    });

    // Display final summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 FINAL SUMMARY');
    console.log('='.repeat(60));
    
    const caseRecord = await prisma.case.findUnique({
      where: { path: tempDir },
      include: {
        documents: true,
      },
    });

    if (caseRecord) {
      console.log(`\nCase: ${caseRecord.name}`);
      console.log(`Path: ${caseRecord.path}`);
      console.log(`Documents: ${caseRecord.documents.length}`);
      console.log('\nDocument Details:');
      caseRecord.documents.forEach((doc, i) => {
        console.log(`  ${i + 1}. ${doc.fileName}`);
        console.log(`     Status: ${doc.status}`);
        console.log(`     Hash: ${doc.hash}`);
        console.log(`     Created: ${doc.createdAt.toISOString()}`);
      });
    }

    console.log('\n✅ All tests completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Error during test:', error);
  } finally {
    // Cleanup
    if (watcher) {
      console.log('🛑 Stopping FileWatcher...');
      await watcher.stop();
    }

    if (tempDir) {
      console.log('🧹 Cleaning up test directory...');
      
      // Clean up database records
      await prisma.document.deleteMany({
        where: {
          case: {
            path: tempDir,
          },
        },
      });
      
      await prisma.case.deleteMany({
        where: {
          path: tempDir,
        },
      });

      // Clean up file system
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log('✨ Cleanup complete!\n');
    }

    await prisma.$disconnect();
  }
}

main().catch(console.error);
