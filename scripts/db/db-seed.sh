#!/bin/bash

###############################################################################
# Sound Suite - Database Seed Script
# 
# This script seeds the database with sample data for testing and development:
# 1. Creates sample case directories
# 2. Adds sample documents with various statuses
# 3. Creates sample job logs
# 
# Usage:
#   ./scripts/db/db-seed.sh
# 
# Requirements: 20.4, 20.5
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Function to print colored messages
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
}

###############################################################################
# Main Script
###############################################################################

print_header "Sound Suite - Database Seed"
echo ""

# Check if .env file exists
if [ ! -f "$PROJECT_ROOT/.env" ]; then
    print_error ".env file not found!"
    print_info "Please copy .env.example to .env and configure it:"
    print_info "  cp .env.example .env"
    exit 1
fi

# Load environment variables
set -a
source "$PROJECT_ROOT/.env"
set +a

# Get database path
DB_PATH="${DATABASE_URL#file:}"
DB_PATH="$PROJECT_ROOT/$DB_PATH"

print_info "Database path: $DB_PATH"

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
    print_error "Database not found!"
    print_info "Please run migrations first:"
    print_info "  ./scripts/db/db-migrate.sh"
    exit 1
fi

echo ""
print_info "Seeding database with sample data..."
echo ""

###############################################################################
# Seed using Node.js script
###############################################################################

# Create a temporary Node.js script to seed the database
SEED_SCRIPT="$PROJECT_ROOT/.tmp-seed.mjs"

cat > "$SEED_SCRIPT" << 'EOF'
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function seed() {
  console.log('Creating sample cases...');
  
  // Sample case directories
  const cases = [
    { name: 'Smith v. Johnson', path: '/Users/legal/cases/smith-v-johnson' },
    { name: 'Doe v. Corporation', path: '/Users/legal/cases/doe-v-corporation' },
    { name: 'Estate of Williams', path: '/Users/legal/cases/estate-williams' },
    { name: 'City v. Developer', path: '/Users/legal/cases/city-v-developer' },
  ];
  
  for (const caseData of cases) {
    const existingCase = await prisma.case.findUnique({
      where: { path: caseData.path }
    });
    
    if (!existingCase) {
      await prisma.case.create({ data: caseData });
      console.log(`  ✓ Created case: ${caseData.name}`);
    } else {
      console.log(`  • Case already exists: ${caseData.name}`);
    }
  }
  
  console.log('\nCreating sample documents...');
  
  // Get all cases
  const allCases = await prisma.case.findMany();
  
  // Sample documents for each case
  const documentStatuses = ['QUEUED', 'PROCESSING', 'INDEXED', 'ERROR'];
  const sampleDocs = [
    'complaint.pdf',
    'answer.pdf',
    'motion-to-dismiss.pdf',
    'discovery-request.pdf',
    'deposition-transcript.pdf',
    'expert-report.pdf',
    'settlement-agreement.pdf',
    'judgment.pdf',
  ];
  
  let docCount = 0;
  
  for (const caseRecord of allCases) {
    // Create 2-3 documents per case
    const numDocs = Math.floor(Math.random() * 2) + 2;
    
    for (let i = 0; i < numDocs; i++) {
      const fileName = sampleDocs[Math.floor(Math.random() * sampleDocs.length)];
      const filePath = `${caseRecord.path}/${fileName}`;
      const hash = crypto.createHash('sha256').update(filePath).digest('hex');
      const status = documentStatuses[Math.floor(Math.random() * documentStatuses.length)];
      
      // Check if document already exists
      const existingDoc = await prisma.document.findUnique({
        where: { hash }
      });
      
      if (!existingDoc) {
        await prisma.document.create({
          data: {
            caseId: caseRecord.id,
            filePath,
            fileName,
            hash,
            status,
            pageCount: status === 'INDEXED' ? Math.floor(Math.random() * 50) + 10 : null,
            detectedExhibits: status === 'INDEXED' ? Math.floor(Math.random() * 5) : 0,
            errorMessage: status === 'ERROR' ? 'Sample error: File processing failed' : null,
          }
        });
        docCount++;
      }
    }
  }
  
  console.log(`  ✓ Created ${docCount} sample documents`);
  
  console.log('\nCreating sample job logs...');
  
  // Create a few job logs
  const jobLogs = [
    {
      documentsQueued: 10,
      documentsProcessed: 8,
      documentsFailed: 2,
      completedAt: new Date(),
      errorSummary: '2 documents failed: OCR timeout',
    },
    {
      documentsQueued: 5,
      documentsProcessed: 5,
      documentsFailed: 0,
      completedAt: new Date(),
      errorSummary: null,
    },
  ];
  
  for (const logData of jobLogs) {
    await prisma.jobLog.create({ data: logData });
  }
  
  console.log(`  ✓ Created ${jobLogs.length} job logs`);
  
  // Display summary
  const caseCount = await prisma.case.count();
  const documentCount = await prisma.document.count();
  const jobLogCount = await prisma.jobLog.count();
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Seed Complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\nDatabase now contains:`);
  console.log(`  • Cases:     ${caseCount}`);
  console.log(`  • Documents: ${documentCount}`);
  console.log(`  • Job Logs:  ${jobLogCount}`);
}

seed()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
EOF

# Run the seed script
cd "$PROJECT_ROOT"
node "$SEED_SCRIPT"

# Clean up
rm -f "$SEED_SCRIPT"

echo ""
print_success "Database seeded successfully"
echo ""

print_info "Next Steps:"
echo "  • Start services: ./scripts/start.sh"
echo "  • View dashboard: http://localhost:3000"
echo "  • Run health check: ./scripts/health-check.sh"
